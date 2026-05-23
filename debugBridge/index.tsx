/*
 * Vencord userplugin: DebugBridge
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Live debugging bridge for Claude Code.
 *
 * Long-polls the discord-mcp-bridge HTTP server (run in WSL by Claude Code)
 * over http://localhost. Discord's CSP blocks ws:// to localhost but allows
 * http://localhost for connect-src, so the transport is HTTP, not WebSocket.
 * The plugin evaluates the JavaScript the agent sends and POSTs back
 * depth-limited, safely-serialized results — letting an agent inspect
 * Discord's live runtime (webpack modules, the DOM, minified class names)
 * instead of guessing blind.
 *
 * A Claude icon sits at the right end of Discord's top bar: click it to turn
 * the bridge on/off. The choice is a persisted plugin setting, so it survives
 * Discord restarts and Ctrl+R. Adding the icon needs a header-bar patch, so
 * deploying a change to this file needs a Vencord rebuild (not just Ctrl+R).
 *
 * SECURITY: while ACTIVE, this evaluates arbitrary JavaScript inside your
 * Discord client. It only talks to localhost and authenticates with a shared
 * token. Click the toolbar icon to pause it whenever you are not debugging.
 */

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { useEffect, useState } from "@webpack/common";
import type { PropsWithChildren } from "react";

const TOKEN = "vc-debug-bridge-2f9a4c1e";          // must match the MCP server
const BASES = ["http://localhost:8787", "http://127.0.0.1:8787"];
const POLL_ABORT_MS = 35_000;                       // > the server's 25s long-poll hold
const BACKOFF_MS = 2_000;                           // wait after a network error
const CONSOLE_LIMIT = 200;

/**
 * Native (main-process) helpers — see native.ts. Vencord populates this at
 * startup; it is `undefined` if Discord has not been fully restarted since
 * native.ts was added (a Ctrl+R reload does NOT register native handlers).
 */
const Native = VencordNative.pluginHelpers.DebugBridge as
    PluginNative<typeof import("./native")> | undefined;

interface LogEntry { level: string; time: string; text: string; }

/* ------------------------------------------------------------ settings -- */

/**
 * `bridgeActive` is the on/off switch behind the toolbar icon. It is a normal
 * persisted plugin setting, so the choice survives Discord restarts and
 * Ctrl+R. `onChange` fires for both the toolbar click and the settings panel,
 * so `applyBridgeState` is the single place that starts/stops the poll loop.
 */
const settings = definePluginSettings({
    bridgeActive: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Bridge active — let a local Claude Code agent inspect and control this client",
        onChange: (active: boolean) => applyBridgeState(active),
    },
});

/**
 * Generation token for the poll loop. Every start/stop bumps it; a running
 * loop keeps going only while its captured `gen` still equals `pollGen`. This
 * makes start/stop idempotent and race-free — a toggle can never wedge the
 * bridge into a state with zero live loops (or two).
 */
let pollGen = 0;
let baseIndex = 0;
let connected = false;
let currentAbort: AbortController | undefined;

/**
 * `connected` changes outside React (in the poll loop). The toolbar icon needs
 * to re-render the instant it flips, so writes go through `setConnected`, which
 * notifies subscribers — no polling, no lag. Always assign via this helper.
 */
const connectionListeners = new Set<() => void>();
function setConnected(value: boolean): void {
    if (connected === value) return;
    connected = value;
    connectionListeners.forEach(cb => { try { cb(); } catch { /* */ } });
}

const consoleBuffer: LogEntry[] = [];
const origConsole: Partial<Record<"error" | "warn", (...a: any[]) => void>> = {};
let onError: ((e: ErrorEvent) => void) | undefined;
let onRejection: ((e: PromiseRejectionEvent) => void) | undefined;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/* ------------------------------------------------------ serialization -- */

/** Convert any value into something safe to JSON.stringify (depth/size-capped). */
function safeSerialize(value: unknown, depth = 8, seen = new WeakSet<object>()): unknown {
    if (value === undefined || value === null) return null;
    const t = typeof value;
    if (t === "string") {
        const s = value as string;
        return s.length > 20000 ? s.slice(0, 20000) + "…[+" + (s.length - 20000) + " chars]" : s;
    }
    if (t === "number" || t === "boolean") return value;
    if (t === "bigint") return String(value) + "n";
    if (t === "symbol") return String(value);
    if (t === "function") return "[Function " + ((value as Function).name || "anonymous") + "]";

    if (typeof Element !== "undefined" && value instanceof Element) {
        return {
            __type: "Element",
            tag: value.tagName.toLowerCase(),
            id: value.id || undefined,
            classes: [...value.classList],
            text: (value.textContent || "").trim().slice(0, 120),
            outerHTML: value.outerHTML.slice(0, 1000),
        };
    }
    if (typeof Node !== "undefined" && value instanceof Node) {
        return { __type: "Node", nodeName: value.nodeName, text: (value.textContent || "").slice(0, 120) };
    }
    if (value instanceof Error) {
        return { __type: "Error", name: value.name, message: value.message, stack: (value.stack || "").slice(0, 1800) };
    }

    if (t === "object") {
        const obj = value as object;
        if (seen.has(obj)) return "[Circular]";
        if (depth <= 0) return Array.isArray(obj) ? "[Array(" + obj.length + ")]" : "[Object]";
        seen.add(obj);
        try {
            if (Array.isArray(obj)) {
                const arr: unknown[] = obj.slice(0, 250).map(v => safeSerialize(v, depth - 1, seen));
                if (obj.length > 250) arr.push("…[+" + (obj.length - 250) + " items]");
                return arr;
            }
            if (obj instanceof Map) {
                return {
                    __type: "Map", size: obj.size,
                    entries: [...obj.entries()].slice(0, 50)
                        .map(([k, v]) => [safeSerialize(k, depth - 1, seen), safeSerialize(v, depth - 1, seen)]),
                };
            }
            if (obj instanceof Set) {
                return {
                    __type: "Set", size: obj.size,
                    values: [...obj].slice(0, 50).map(v => safeSerialize(v, depth - 1, seen)),
                };
            }
            const out: Record<string, unknown> = {};
            let n = 0;
            for (const key of Object.keys(obj)) {
                if (n++ >= 250) { out["…"] = "[more keys omitted]"; break; }
                try {
                    out[key] = safeSerialize((obj as Record<string, unknown>)[key], depth - 1, seen);
                } catch (e) {
                    out[key] = "[accessor threw: " + String(e) + "]";
                }
            }
            return out;
        } finally {
            seen.delete(obj);
        }
    }
    return String(value);
}

/* --------------------------------------------------------------- eval -- */

async function runCode(code: string): Promise<unknown> {
    let fn: Function;
    try {
        // try as a single expression first
        fn = new Function("return (async () => (" + code + "\n))();");
    } catch {
        // fall back to a statement body — the caller must use an explicit `return`
        fn = new Function("return (async () => { " + code + "\n })();");
    }
    return await fn();
}

/** Run the agent's code and return a JSON string {id, ok, result|error}. */
async function buildReply(id: string, code: string, depth: number): Promise<string> {
    let reply: { id: string; ok: boolean; result?: unknown; error?: string };
    try {
        reply = { id, ok: true, result: safeSerialize(await runCode(code), depth) };
    } catch (e: any) {
        reply = { id, ok: false, error: String((e && (e.stack || e.message)) || e) };
    }

    let payload: string;
    try {
        payload = JSON.stringify(reply);
    } catch (e) {
        payload = JSON.stringify({ id, ok: false, error: "Result could not be serialized: " + String(e) });
    }
    if (payload.length > 600_000)
        payload = JSON.stringify({ id, ok: false, error: "Result too large (" + payload.length + " bytes) — narrow the query or lower depth." });
    return payload;
}

/* --------------------------------------------------------- screenshot -- */

/**
 * Handle a `kind: "screenshot"` command. `optsJson` is JSON {selector?,
 * maxWidth?, format?, quality?}. Resolves a `selector` to a viewport rect here
 * (the renderer owns the DOM), then hops to native.ts for the actual capture.
 * Returns the reply JSON string — bypassing buildReply's size caps, since a
 * base64 image legitimately runs well past the 20k-char string cap.
 */
async function buildScreenshotReply(id: string, optsJson: string): Promise<string> {
    try {
        if (!Native || typeof Native.captureScreenshot !== "function")
            throw new Error(
                "Native screenshot helper unavailable — fully quit and reopen Discord " +
                "once (Ctrl+R is not enough; native handlers register only at startup).");

        const opts = optsJson.trim() ? JSON.parse(optsJson) : {};
        let rect: { x: number; y: number; width: number; height: number; } | undefined;

        if (typeof opts.selector === "string" && opts.selector) {
            const el = document.querySelector(opts.selector);
            if (!el)
                return JSON.stringify({ id, ok: false, error: "selector matched nothing: " + opts.selector });
            try { el.scrollIntoView({ block: "center" }); } catch { /* */ }
            await sleep(150);                       // let the scroll settle before capturing
            const r = el.getBoundingClientRect();
            const x = Math.max(0, Math.floor(r.left));
            const y = Math.max(0, Math.floor(r.top));
            rect = {
                x, y,
                width: Math.min(Math.ceil(r.width), window.innerWidth - x),
                height: Math.min(Math.ceil(r.height), window.innerHeight - y),
            };
            if (rect.width < 1 || rect.height < 1)
                return JSON.stringify({ id, ok: false, error: "element is off-screen or has zero size: " + opts.selector });
        }

        const result = await Native.captureScreenshot({
            rect,
            maxWidth: typeof opts.maxWidth === "number" ? opts.maxWidth : undefined,
            format: opts.format === "jpeg" ? "jpeg" : "png",
            quality: typeof opts.quality === "number" ? opts.quality : undefined,
        });
        return JSON.stringify({ id, ok: true, result });
    } catch (e: any) {
        return JSON.stringify({ id, ok: false, error: String((e && (e.stack || e.message)) || e) });
    }
}

/* ------------------------------------------------------- poll transport -- */

async function pollOnce(): Promise<void> {
    const base = BASES[baseIndex % BASES.length];
    const ctrl = new AbortController();
    currentAbort = ctrl;
    const abortTimer = setTimeout(() => ctrl.abort(), POLL_ABORT_MS);

    let res: Response;
    try {
        res = await fetch(base + "/poll?token=" + TOKEN, { method: "POST", signal: ctrl.signal });
    } catch (e) {
        setConnected(false);
        baseIndex++;                       // network / abort error — try the other host next
        throw e;
    } finally {
        clearTimeout(abortTimer);
    }

    if (!connected) origConsole.warn?.call(console, "[DebugBridge] connected:", base);
    setConnected(true);

    if (res.status === 204 || !res.ok) return;          // no command waiting — re-poll

    let cmd: { id?: unknown; code?: unknown; depth?: unknown; kind?: unknown; };
    try { cmd = await res.json(); } catch { return; }
    if (typeof cmd.id !== "string" || typeof cmd.code !== "string") return;

    const depth = typeof cmd.depth === "number" && cmd.depth > 0 ? cmd.depth : 8;
    const payload = cmd.kind === "screenshot"
        ? await buildScreenshotReply(cmd.id, cmd.code)
        : await buildReply(cmd.id, cmd.code, depth);
    // No custom headers / plain-text body keeps this a "simple" CORS request (no preflight).
    try {
        await fetch(base + "/result?token=" + TOKEN, { method: "POST", body: payload });
    } catch { /* result lost — that server call will time out; carry on */ }
}

async function pollLoop(gen: number): Promise<void> {
    while (gen === pollGen) {
        try {
            await pollOnce();
        } catch {
            setConnected(false);
            if (gen === pollGen) await sleep(BACKOFF_MS);
        }
    }
}

/* ------------------------------------------------------ poll lifecycle -- */

/**
 * Stop the long-poll loop and abort any in-flight request. Idempotent.
 * Bumping `pollGen` retires the running loop: it exits at its next check,
 * including mid-way through the post-error backoff sleep.
 */
function stopPolling(): void {
    pollGen++;
    setConnected(false);
    try { currentAbort?.abort(); } catch { /* */ }
    currentAbort = undefined;
}

/**
 * (Re)start the long-poll loop, guaranteeing exactly one live loop afterwards.
 * Idempotent and safe under rapid toggling: `stopPolling` first retires any
 * existing loop, then the loop started here owns the fresh `pollGen`.
 */
function startPolling(): void {
    stopPolling();
    const gen = pollGen;
    baseIndex = 0;
    setConnected(false);
    void pollLoop(gen);
}

/** Bring the poll loop in line with the desired active state. */
function applyBridgeState(active: boolean): void {
    if (active) startPolling();
    else stopPolling();
}

/* ------------------------------------------------------ console capture -- */

function pushLog(level: string, args: unknown[]): void {
    let text: string;
    try {
        text = args.map(a => {
            if (typeof a === "string") return a;
            if (a instanceof Error) return a.stack || a.message;
            try { return JSON.stringify(safeSerialize(a, 2)); } catch { return String(a); }
        }).join(" ");
    } catch { text = "[unserializable log entry]"; }
    consoleBuffer.push({ level, time: new Date().toISOString(), text: text.slice(0, 4000) });
    if (consoleBuffer.length > CONSOLE_LIMIT)
        consoleBuffer.splice(0, consoleBuffer.length - CONSOLE_LIMIT);
}

function installConsoleCapture(): void {
    (["error", "warn"] as const).forEach(level => {
        origConsole[level] = console[level];
        console[level] = function (...args: unknown[]) {
            pushLog(level, args);
            origConsole[level]!.apply(console, args);
        };
    });
    onError = e => pushLog("uncaught", [e.message, (e.filename || "") + ":" + e.lineno, e.error]);
    onRejection = e => pushLog("unhandledrejection", [e.reason]);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
}

function removeConsoleCapture(): void {
    (["error", "warn"] as const).forEach(level => {
        if (origConsole[level]) { console[level] = origConsole[level]!; delete origConsole[level]; }
    });
    if (onError) window.removeEventListener("error", onError);
    if (onRejection) window.removeEventListener("unhandledrejection", onRejection);
    onError = onRejection = undefined;
}

/* ------------------------------------------------------- send message -- */

interface SendArgs {
    channelId?: string;
    content?: string;
    replyToMessageId?: string;
    files?: Array<{ name: string; mime?: string; base64: string; }>;
    tts?: boolean;
    typing?: boolean;
    typingMs?: number;
}

/**
 * Send a message natively via Discord's MessageActions / UploadManager —
 * exposed at `$discordBridge.sendMessage` for the MCP `discord_send` tool.
 *
 * Path A (no files): `MessageActions.sendMessage(channelId, msg, undefined, opts)`
 *   — the same code path Discord's own composer uses; passes through mention
 *   parsing, slash-command sniffing, reply refs, etc.
 *
 * Path B (files): `UploadManager.uploadFiles({...})` — direct upload pipeline
 *   without the attach-modal `promptToUpload` would otherwise show.
 *
 * Always returns the resolved channel info so the agent can verify *where*
 * the message landed before trusting the send.
 */
async function bridgeSendMessage(args: SendArgs): Promise<unknown> {
    const W = (globalThis as any).Vencord?.Webpack;
    if (!W?.findByProps) throw new Error("Vencord.Webpack is not ready yet.");

    const SelectedChannelStore = W.findByProps("getChannelId", "getVoiceChannelId");
    const ChannelStore = W.findByProps("getChannel", "hasChannel");
    const MessageActions = W.findByProps("sendMessage", "editMessage");
    const GuildStore = W.findByProps("getGuild", "getGuilds");

    const id = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!id) throw new Error("No channel selected and no channelId provided.");
    const channel = ChannelStore?.getChannel?.(id);
    if (!channel) throw new Error("Channel not found: " + id);

    const channelInfo = {
        id,
        name: channel.name || (channel.recipients?.length ? "(DM)" : null),
        guildId: channel.guild_id || null,
        guildName: channel.guild_id
            ? (GuildStore?.getGuild?.(channel.guild_id)?.name ?? null)
            : null,
    };

    const messageReference = args.replyToMessageId ? {
        message_id: args.replyToMessageId,
        channel_id: id,
        guild_id: channel.guild_id || undefined,
    } : undefined;

    const tts = !!args.tts;
    const content = args.content ?? "";

    // Optional "pretend to be typing" pause before the send fires. `typingMs`
    // is explicit; `typing: true` auto-derives from content length, ~60ms/char
    // clamped to [800ms, 6000ms] — roughly natural human pacing. Discord
    // stops the typing indicator automatically when the message lands, so no
    // explicit stopTyping needed.
    let typingMs: number | undefined;
    if (typeof args.typingMs === "number" && args.typingMs > 0) typingMs = args.typingMs;
    else if (args.typing) {
        const len = content.length;
        typingMs = Math.max(800, Math.min(6000, len * 60));
    }
    if (typingMs) {
        const TypingActions = W.findByProps("startTyping", "stopTyping");
        if (TypingActions?.startTyping) {
            try { TypingActions.startTyping(id); } catch { /* */ }
            // Discord's typing indicator self-times out after ~10s; repeat the
            // start every ~8s so longer pretend-typing durations stay visible.
            const start = Date.now();
            while (Date.now() - start < typingMs) {
                const remaining = typingMs - (Date.now() - start);
                await new Promise(r => setTimeout(r, Math.min(remaining, 8000)));
                if (Date.now() - start < typingMs) {
                    try { TypingActions.startTyping(id); } catch { /* */ }
                }
            }
        }
    }

    if (args.files?.length) {
        const fileObjs = args.files.map(f => {
            const bin = atob(f.base64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            return new File([arr], f.name, { type: f.mime || "application/octet-stream" });
        });

        const UploadManager = W.findByProps("uploadFiles");
        if (!UploadManager?.uploadFiles)
            throw new Error("UploadManager.uploadFiles not found — webpack module shape may have changed.");

        await UploadManager.uploadFiles({
            channelId: id,
            draftType: 0,
            parsedMessage: {
                content,
                invalidEmojis: [],
                tts,
                channel_id: id,
                ...(messageReference ? { messageReference } : {}),
            },
            uploads: fileObjs.map(file => ({
                file,
                platform: 1,
                isClip: false,
                isThumbnail: false,
                draftType: 0,
            })),
        });
    } else {
        if (!content.trim())
            throw new Error("`content` is required when no `files` are provided.");
        if (!MessageActions?.sendMessage)
            throw new Error("MessageActions.sendMessage not found — webpack module shape may have changed.");

        // 4th arg is `options` — Discord reads `.nonce` off it unconditionally,
        // so must be an object (never undefined). 3rd arg is the
        // "wait-for-channel-ready" boolean, default true.
        await MessageActions.sendMessage(id, {
            content,
            invalidEmojis: [],
            validNonShortcutEmojis: [],
            tts,
        }, true, messageReference ? { messageReference } : {});
    }

    return {
        ok: true,
        channel: channelInfo,
        content,
        fileCount: args.files?.length || 0,
        replyTo: args.replyToMessageId || null,
        tts,
    };
}

/* ----------------------------------------------------- view current view -- */

interface GetViewArgs {
    limit?: number;
    includeEmbeds?: boolean;
    includeReactions?: boolean;
}

/**
 * Read what the user is currently looking at — the selected channel and the
 * messages rendered in the viewport. Discord virtualizes off-screen messages
 * out of the DOM, so scraping `[id^="chat-messages-"]` is naturally
 * scroll-scoped: if the user scrolled up to look at history, *that* is what
 * the agent sees here.
 *
 * Each rendered ID is then looked up in MessageStore for full message data
 * (author, attachments, reply refs, reactions) — DOM gives the viewport,
 * webpack gives the fidelity.
 */
function bridgeGetView(args: GetViewArgs = {}): unknown {
    const W = (globalThis as any).Vencord?.Webpack;
    if (!W?.findByProps) throw new Error("Vencord.Webpack is not ready yet.");

    const SelectedChannelStore = W.findByProps("getChannelId", "getVoiceChannelId");
    const ChannelStore = W.findByProps("getChannel", "hasChannel");
    const MessageStore = W.findByProps("getMessages", "getMessage");
    const UserStore = W.findByProps("getCurrentUser", "getUser");
    const GuildStore = W.findByProps("getGuild", "getGuilds");

    const channelId = SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel currently selected.");
    const channel = ChannelStore?.getChannel?.(channelId);
    if (!channel) throw new Error("Selected channel not found in ChannelStore: " + channelId);

    const guild = channel.guild_id ? GuildStore?.getGuild?.(channel.guild_id) : null;
    const viewer = UserStore?.getCurrentUser?.();

    // Discord message DOM IDs: `chat-messages-${channelId}-${messageId}` (or
    // older `chat-messages-${messageId}` in some surfaces). Pull the trailing
    // digit run either way; preserve render order; de-dupe.
    const els = [...document.querySelectorAll<HTMLElement>('[id^="chat-messages-"]')];
    const limit = Math.max(1, Math.min(200, args.limit ?? 100));
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const el of els) {
        const m = (el.id || "").match(/(\d{15,})\s*$/);
        if (!m) continue;
        const id = m[1];
        if (seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }

    const slice = ids.slice(-limit);
    const renderName = (u: any) =>
        u?.globalName ?? u?.global_name ?? u?.username ?? null;
    const tsIso = (t: any) =>
        typeof t?.toISOString === "function" ? t.toISOString() : (t ? String(t) : null);

    const messages: any[] = [];
    let unresolved = 0;
    for (const id of slice) {
        const msg = MessageStore?.getMessage?.(channelId, id);
        if (!msg) { unresolved++; continue; }
        const out: any = {
            id: msg.id,
            timestamp: tsIso(msg.timestamp),
            author: msg.author ? {
                id: msg.author.id,
                username: msg.author.username,
                name: renderName(msg.author),
                bot: !!msg.author.bot,
            } : null,
            content: msg.content || "",
        };
        const edited = tsIso(msg.editedTimestamp);
        if (edited) out.edited = edited;

        if (msg.attachments?.length) {
            out.attachments = msg.attachments.map((a: any) => ({
                name: a.filename || a.name,
                url: a.url,
                contentType: a.content_type || a.contentType,
                size: a.size,
                width: a.width, height: a.height,
            }));
        }

        if (msg.messageReference?.message_id) {
            const refId = msg.messageReference.message_id;
            const refChan = msg.messageReference.channel_id || channelId;
            const ref = MessageStore?.getMessage?.(refChan, refId);
            out.replyTo = ref ? {
                id: ref.id,
                authorId: ref.author?.id,
                authorName: renderName(ref.author),
                contentPreview: (ref.content || "").slice(0, 160),
            } : { id: refId, unloaded: true };
        }

        if (msg.mentions?.length) {
            out.mentions = msg.mentions.map((m: any) =>
                typeof m === "string" ? { id: m } : { id: m.id, name: renderName(m) });
        }
        if (msg.mentionRoles?.length) out.mentionRoles = [...msg.mentionRoles];
        if (msg.mentionEveryone) out.mentionEveryone = true;

        if (msg.embeds?.length) {
            if (args.includeEmbeds) {
                out.embeds = msg.embeds.map((e: any) => ({
                    type: e.type,
                    title: e.title,
                    description: (e.description || e.rawDescription || "").slice(0, 400),
                    url: e.url,
                    author: e.author?.name,
                    providerName: e.provider?.name,
                }));
            } else {
                out.embedCount = msg.embeds.length;
            }
        }

        if (msg.reactions?.length) {
            if (args.includeReactions) {
                out.reactions = msg.reactions.map((r: any) => ({
                    emoji: r.emoji?.name || r.emoji?.id || String(r.emoji),
                    count: r.count, me: !!r.me,
                }));
            } else {
                out.reactionCount = msg.reactions.length;
            }
        }

        if (msg.flags) out.flags = msg.flags;
        if (msg.pinned) out.pinned = true;
        if (msg.type && msg.type !== 0) out.type = msg.type;

        messages.push(out);
    }

    // The chat scroller — its scrollTop / atBottom hint tells the agent
    // whether the user is following live (bottom) or browsing history.
    const scroller = document.querySelector<HTMLElement>(
        '[class*="messagesWrapper"] [class*="scroller"], [data-list-id="chat-messages"]');
    const scrollInfo = scroller ? {
        scrollTop: Math.round(scroller.scrollTop),
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        atBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 4,
    } : null;

    return {
        channel: {
            id: channel.id,
            name: channel.name || (channel.recipients?.length ? "(DM)" : null),
            type: channel.type,
            topic: channel.topic || null,
            guildId: channel.guild_id || null,
            guildName: guild?.name || null,
            parentId: channel.parent_id || null,
        },
        viewer: viewer ? {
            id: viewer.id,
            username: viewer.username,
            name: renderName(viewer),
        } : null,
        scroll: scrollInfo,
        renderedCount: messages.length,
        unresolved,
        messages,
    };
}

/* ------------------------------------------------------- list DMs -------- */

interface ListDMsArgs {
    query?: string;
    limit?: number;
}

interface DMEntry {
    channelId: string;
    kind: "dm" | "group";
    name: string;
    memberCount?: number;
    recipients: Array<{
        id: string;
        username?: string;
        name?: string | null;
        nickname?: string | null;
        bot?: boolean;
    }>;
}

/**
 * List DM + group-DM channels in sidebar order, optionally ranked against a
 * query string. Lets an agent resolve "Kavi" → channelId without the user
 * having to dig out an opaque ID.
 *
 * Match score, highest wins: exact (100) > prefix (75) > substring (50).
 * Scored across the DM display name, every recipient's display name, and
 * every recipient's username.
 */
function bridgeListDMs(args: ListDMsArgs = {}): unknown {
    const W = (globalThis as any).Vencord?.Webpack;
    if (!W?.findByProps) throw new Error("Vencord.Webpack is not ready yet.");

    const ChannelStore = W.findByProps("getChannel", "hasChannel");
    const UserStore = W.findByProps("getCurrentUser", "getUser");
    const SortStore = W.findByProps("getPrivateChannelIds")
        ?? W.findByProps("getSortedPrivateChannels");
    // Discord's native friend-nickname store — what the sidebar actually
    // shows when a user has renamed a friend (e.g. "Avery" → "Dragãozinha").
    const RelationshipStore = W.findByProps("getRelationshipType", "isFriend");

    // Get DM channel IDs in the order Discord shows them in the sidebar; fall
    // back to ChannelStore directly if the sort store moved/renamed.
    let dmIds: string[] = [];
    if (typeof SortStore?.getPrivateChannelIds === "function") {
        dmIds = SortStore.getPrivateChannelIds();
    } else if (typeof ChannelStore?.getSortedPrivateChannels === "function") {
        dmIds = ChannelStore.getSortedPrivateChannels().map((c: any) => c.id);
    } else if (typeof ChannelStore?.getMutablePrivateChannels === "function") {
        dmIds = Object.keys(ChannelStore.getMutablePrivateChannels());
    } else {
        throw new Error("No DM-listing webpack module found (getPrivateChannelIds / getSortedPrivateChannels / getMutablePrivateChannels).");
    }

    const renderName = (u: any) => u?.globalName ?? u?.global_name ?? u?.username ?? null;

    const all: DMEntry[] = dmIds.map(id => {
        const ch = ChannelStore?.getChannel?.(id);
        if (!ch) return null;
        const isGroup = ch.type === 3;
        const recipientIds: string[] = ch.recipients || ch.recipientIds || [];
        const recipients = recipientIds.map(rid => {
            const u = UserStore?.getUser?.(rid);
            const nickname = RelationshipStore?.getNickname?.(rid) || null;
            return u ? {
                id: u.id,
                username: u.username,
                name: renderName(u),
                nickname,
                bot: !!u.bot,
            } : { id: rid, nickname };
        });
        // For 1:1 DMs, prefer the friend-nickname so the listed `name` matches
        // what the user actually sees in the sidebar — that is what they will
        // type when asking the agent to send to "Dragãozinha".
        const name = isGroup
            ? (ch.name || recipients.map(r => (r as any).nickname || r.name || r.username).filter(Boolean).join(", ") || "(group)")
            : ((recipients[0] as any)?.nickname || recipients[0]?.name || recipients[0]?.username || "(unknown)");
        return {
            channelId: id,
            kind: isGroup ? "group" : "dm",
            name,
            memberCount: isGroup ? recipients.length : undefined,
            recipients,
        };
    }).filter(Boolean) as DMEntry[];

    const q = (args.query || "").trim().toLowerCase();
    let results = all;
    if (q) {
        const score = (dm: DMEntry) => {
            const targets = [
                dm.name,
                ...dm.recipients.flatMap(r => [(r as any).nickname, r.name, r.username]),
            ];
            let best = -1;
            for (const t of targets) {
                const lo = (t || "").toLowerCase();
                if (!lo) continue;
                if (lo === q) best = Math.max(best, 100);
                else if (lo.startsWith(q)) best = Math.max(best, 75);
                else if (lo.includes(q)) best = Math.max(best, 50);
            }
            return best;
        };
        results = all
            .map(dm => ({ dm, s: score(dm) }))
            .filter(x => x.s >= 0)
            .sort((a, b) => b.s - a.s)
            .map(x => x.dm);
    }

    const limit = Math.max(1, Math.min(100, args.limit ?? (q ? 10 : 50)));
    return {
        total: all.length,
        matched: q ? results.length : undefined,
        query: q || undefined,
        dms: results.slice(0, limit),
    };
}

/* ----------------------------------------------------- open a channel ---- */

interface OpenChannelArgs {
    channelId: string;
    messageId?: string;
}

/**
 * Switch Discord to a channel — dispatches the same action the sidebar does
 * (`ChannelActions.selectChannel`). For DMs guildId is null; for guild
 * channels we look it up from ChannelStore so the caller need not provide it.
 * `messageId` scroll-jumps to that message (Discord handles the
 * fetch-around-and-highlight flow).
 */
async function bridgeOpenChannel(args: OpenChannelArgs): Promise<unknown> {
    const W = (globalThis as any).Vencord?.Webpack;
    if (!W?.findByProps) throw new Error("Vencord.Webpack is not ready yet.");

    const ChannelStore = W.findByProps("getChannel", "hasChannel");
    const SelectedChannelStore = W.findByProps("getChannelId", "getVoiceChannelId");
    const ChannelActions = W.findByProps("selectChannel", "selectVoiceChannel");
    const GuildStore = W.findByProps("getGuild", "getGuilds");
    const UserStore = W.findByProps("getCurrentUser", "getUser");

    if (!ChannelActions?.selectChannel)
        throw new Error("ChannelActions.selectChannel not found — webpack module shape may have changed.");

    const channel = ChannelStore?.getChannel?.(args.channelId);
    if (!channel) throw new Error("Channel not found in ChannelStore: " + args.channelId);

    const guildId = channel.guild_id || null;
    ChannelActions.selectChannel({
        guildId,
        channelId: args.channelId,
        messageId: args.messageId,
    });

    // Selection dispatches synchronously, but the renderer redraw takes a
    // frame or two. Poll briefly so callers get an accurate "did it flip?".
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
        if (SelectedChannelStore?.getChannelId?.() === args.channelId) break;
        await new Promise(r => setTimeout(r, 50));
    }

    const guild = guildId ? GuildStore?.getGuild?.(guildId) : null;
    const renderName = (u: any) => u?.globalName ?? u?.global_name ?? u?.username ?? null;
    const recipientIds: string[] = channel.recipients || channel.recipientIds || [];
    const recipients = recipientIds.map(rid => {
        const u = UserStore?.getUser?.(rid);
        return u ? { id: u.id, username: u.username, name: renderName(u) } : { id: rid };
    });

    const current = SelectedChannelStore?.getChannelId?.();
    return {
        ok: current === args.channelId,
        currentChannelId: current,
        channel: {
            id: channel.id,
            name: channel.name || (recipients[0]?.name ?? recipients[0]?.username ?? null),
            type: channel.type,
            guildId,
            guildName: guild?.name || null,
            recipients: recipients.length ? recipients : undefined,
        },
        scrolledToMessage: args.messageId || null,
    };
}

/* -------------------------------------------------------- toolbar icon -- */

/** Discord's header-bar icon button — the inbox / help cluster, top right. */
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

/** Official Claude logomark (Simple Icons, 24×24 viewBox). */
const CLAUDE_LOGO_PATH = "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";

/**
 * Claude burst — clay orange when the bridge is active, muted when paused.
 * `pulsing` adds a slow SMIL fill animation: a breathing "live" indicator
 * shown while the bridge is genuinely connected to the daemon.
 */
function ClaudeIcon({ active, pulsing }: { active: boolean; pulsing: boolean; }) {
    return (
        <svg viewBox="0 0 24 24" width={18} height={18}>
            <path fill={active ? "#D97757" : "currentColor"} d={CLAUDE_LOGO_PATH}>
                {pulsing && (
                    <animate
                        attributeName="fill"
                        values="#D97757;#F4AC8C;#D97757"
                        dur="1.8s"
                        repeatCount="indefinite"
                    />
                )}
            </path>
        </svg>
    );
}

/**
 * The toolbar button — click toggles the bridge; colour tracks state. The icon
 * pulses while the bridge is live, so it subscribes to `connectionListeners`
 * and re-renders the instant `connected` flips — no polling, no lag.
 */
function ClaudeBridgeButton() {
    const { bridgeActive } = settings.use(["bridgeActive"]);
    const [online, setOnline] = useState(connected);
    useEffect(() => {
        const sync = () => setOnline(connected);
        connectionListeners.add(sync);
        sync();                            // catch a flip between render and effect
        return () => { connectionListeners.delete(sync); };
    }, []);

    const live = bridgeActive && online;
    return (
        <HeaderBarIcon
            tooltip={!bridgeActive
                ? "Claude bridge OFF — click to let Claude Code connect."
                : live
                    ? "Claude bridge ON — agent connected. Click to pause."
                    : "Claude bridge ON — waiting for Claude Code…"}
            icon={() => <ClaudeIcon active={bridgeActive} pulsing={live} />}
            selected={bridgeActive}
            onClick={() => { settings.store.bridgeActive = !settings.store.bridgeActive; }}
        />
    );
}

/* -------------------------------------------------------------- plugin -- */

export default definePlugin({
    name: "DebugBridge",
    description:
        "Live debugging bridge — lets a local Claude Code agent inspect and eval inside " +
        "this Discord client over localhost HTTP (token-gated). Toggle it from the toolbar.",
    authors: [{ name: "fagner", id: 0n }],

    settings,

    // Append the Claude toggle into the header bar's trailing (right) slot.
    patches: [
        {
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(trailing:.{0,50}?)\i\.Fragment,(?=\{children:\[)/,
                replace: "$1$self.TrailingWrapper,"
            }
        }
    ],

    TrailingWrapper({ children }: PropsWithChildren) {
        return (
            <>
                {children}
                <ErrorBoundary key="vc-debugbridge" noop>
                    <ClaudeBridgeButton />
                </ErrorBoundary>
            </>
        );
    },

    start() {
        pollGen++; // retire any loop left over from a prior start
        baseIndex = 0;
        setConnected(false);
        consoleBuffer.length = 0;
        installConsoleCapture();
        (globalThis as any).$discordBridge = {
            version: 15,
            console: consoleBuffer,
            isConnected: () => connected,
            isActive: () => settings.store.bridgeActive,
            sendMessage: bridgeSendMessage,
            getView: bridgeGetView,
            listDMs: bridgeListDMs,
            openChannel: bridgeOpenChannel,
        };
        // Resume whatever state the toolbar icon was left in last session.
        if (settings.store.bridgeActive) startPolling();
    },

    stop() {
        stopPolling();
        removeConsoleCapture();
        delete (globalThis as any).$discordBridge;
    },
});
