/*
 * Vencord userplugin: DiscordMCP
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
const Native = VencordNative.pluginHelpers.DiscordMCP as
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

    if (!connected) origConsole.warn?.call(console, "[DiscordMCP] connected:", base);
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
 * Send a message natively via Discord's MessageActions — exposed at
 * `$discordBridge.sendMessage` for the MCP `discord_send` tool.
 *
 * Path A (no files): `MessageActions.sendMessage(channelId, msg, true, opts)`
 *   — the same code path Discord's own composer uses; passes through mention
 *   parsing, slash-command sniffing, reply refs, etc.
 *
 * Path B (files): wrap each File in a `CloudUpload` and pass them as
 *   `options.attachmentsToUpload` to the same `sendMessage` — `_sendMessage`
 *   runs the upload pipeline + send together, no attach modal.
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

    // Pre-validate replyToMessageId against the local MessageStore. Discord
    // rejects replies to unknown message IDs with a Clyde "could not be
    // delivered" DM — but the local renderer optimistically shows the message
    // anyway, so the failure is invisible to the caller. Catching it here
    // turns a silent delivery failure into a surfaced error.
    if (args.replyToMessageId) {
        const MessageStore = W.findByProps("getMessage", "getMessages");
        const stored = MessageStore?.getMessage?.(id, args.replyToMessageId);
        if (!stored) {
            throw new Error(
                `replyToMessageId ${args.replyToMessageId} not found in channel ${id}'s ` +
                "local message store. Discord would reject this reply with a Clyde error. " +
                "Pull message IDs from a fresh discord_view result for this channel."
            );
        }
    }

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

        // Discord retired the old `UploadManager.uploadFiles(...)` one-shot.
        // New flow: build CloudUpload instances per file, then call
        // `MessageActions.sendMessage` with them in `options.attachmentsToUpload`
        // — `_sendMessage` runs the upload pipeline + send in one go.
        const CloudUpload = W.findByCode("uploadAnalytics", "preCompressionSize");
        if (typeof CloudUpload !== "function")
            throw new Error("CloudUpload class not found — webpack module shape may have changed.");
        if (!MessageActions?.sendMessage)
            throw new Error("MessageActions.sendMessage not found — webpack module shape may have changed.");

        const uploads = fileObjs.map(file => new CloudUpload({
            file,
            platform: 1, // WEB
            isClip: false,
            isThumbnail: false,
        }, id));

        await MessageActions.sendMessage(id, {
            content,
            invalidEmojis: [],
            validNonShortcutEmojis: [],
            tts,
        }, true, {
            attachmentsToUpload: uploads,
            ...(messageReference ? { messageReference } : {}),
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
    resolveReplies?: number;
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
async function bridgeGetView(args: GetViewArgs = {}): Promise<unknown> {
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

    // Inline reply-chain expansion: for each rendered message with a `replyTo`,
    // walk up to N parents (REST-fetching any that aren't in MessageStore) and
    // embed them as `replyChain` (oldest→newest). Removes `{unloaded: true}`
    // limitations for replies whose parent was scrolled out.
    const resolveDepth = Math.max(0, Math.min(20, args.resolveReplies ?? 0));
    if (resolveDepth > 0) {
        const token = getAuthToken(W);
        for (const m of messages) {
            const startId = m.replyTo?.id;
            if (!startId) continue;
            try {
                m.replyChain = await walkReplyChain(channelId, startId, resolveDepth, W, token);
                if (m.replyTo?.unloaded && m.replyChain.length) {
                    // Replace the placeholder with the resolved tip so callers
                    // don't have to look at two fields.
                    const tip = m.replyChain[m.replyChain.length - 1];
                    if (tip && !tip.unloaded) {
                        m.replyTo = {
                            id: tip.id,
                            authorId: tip.author?.id,
                            authorName: tip.author?.name,
                            contentPreview: (tip.content || "").slice(0, 160),
                        };
                    }
                }
            } catch { /* leave the shallow replyTo alone on failure */ }
        }
    }

    // Participants: presence + typing for the people actually in this channel.
    // For DMs/groups use channel.recipients; for guild channels we don't have a
    // member list cheaply, so fall back to recent message authors in `messages`.
    const PresenceStore = W.findByProps("getStatus", "getActivities")
        ?? W.findByProps("getStatus", "isMobileOnline");
    const TypingStore = W.findByProps("getTypingUsers", "isTyping");
    const recipientIds: string[] = channel.recipients || channel.recipientIds || [];
    const participantIds = new Set<string>(recipientIds);
    if (!participantIds.size) {
        for (const m of messages) if (m.author?.id) participantIds.add(m.author.id);
    }
    if (viewer?.id) participantIds.add(viewer.id);
    const typingMap = TypingStore?.getTypingUsers?.(channelId) || {};
    const typingSet = new Set<string>(Array.isArray(typingMap) ? typingMap : Object.keys(typingMap));
    const participants = [...participantIds].map(uid => {
        const u = UserStore?.getUser?.(uid);
        return {
            userId: uid,
            name: renderName(u) || null,
            presence: PresenceStore?.getStatus?.(uid) || "offline",
            typing: typingSet.has(uid),
        };
    });

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
        participants,
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

/* --------------------------------------------- history / search / stats -- */

const DISCORD_EPOCH = 1420070400000n;

function snowflakeToIso(snowflake: string): string | null {
    try { return new Date(Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH)).toISOString(); }
    catch { return null; }
}

/** ISO timestamp (or Date-parseable string) → Discord snowflake bound. */
function isoToSnowflake(iso: string): string | null {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return null;
    return (((BigInt(ms) - DISCORD_EPOCH) << 22n)).toString();
}

/** Pull the live user auth token from Discord's webpack stores. */
function getAuthToken(W: any): string {
    const m = W.findByProps?.("getToken") || W.findByProps?.("getCachedToken");
    const tok = m?.getToken?.() || m?.getCachedToken?.();
    if (!tok) throw new Error("Auth token unavailable from webpack — not logged in, or token store moved.");
    return tok;
}

/** Raw REST message → caller-facing projection driven by `select`. `id` always present. */
function projectMessage(msg: any, select: Set<string>): any {
    const out: any = { id: msg.id };
    if (select.has("content")) out.content = msg.content || "";
    if (select.has("timestamp")) out.timestamp = msg.timestamp || snowflakeToIso(msg.id);
    if (select.has("author") && msg.author) out.author = {
        id: msg.author.id,
        username: msg.author.username,
        name: msg.author.global_name ?? msg.author.globalName ?? msg.author.username,
        bot: !!msg.author.bot,
    };
    if (select.has("attachments") && msg.attachments?.length) {
        out.attachments = msg.attachments.map((a: any) => ({
            name: a.filename || a.name,
            url: a.url,
            size: a.size,
            contentType: a.content_type || a.contentType,
            width: a.width, height: a.height,
        }));
    }
    if (select.has("replyTo") && msg.message_reference?.message_id) {
        out.replyTo = {
            id: msg.message_reference.message_id,
            channelId: msg.message_reference.channel_id,
        };
    }
    if (select.has("mentions") && msg.mentions?.length) {
        out.mentions = msg.mentions.map((u: any) => ({
            id: u.id, name: u.global_name ?? u.globalName ?? u.username,
        }));
    }
    if (select.has("reactions") && msg.reactions?.length) {
        out.reactions = msg.reactions.map((r: any) => ({
            emoji: r.emoji?.name || r.emoji?.id || String(r.emoji),
            count: r.count, me: !!r.me,
        }));
    }
    if (select.has("edited") && msg.edited_timestamp) out.edited = msg.edited_timestamp;
    return out;
}

/** GET /channels/{id}/messages with retry on 429. Returns raw Discord array. */
async function restFetchMessages(channelId: string, params: Record<string, string | number>, token: string): Promise<any[]> {
    const u = new URL(`https://discord.com/api/v9/channels/${channelId}/messages`);
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
    const r = await fetch(u.toString(), { headers: { authorization: token } });
    if (r.status === 429) {
        const j = await r.json().catch(() => ({} as any));
        const wait = Math.min(10_000, Math.max(250, (j.retry_after || 1) * 1000));
        await sleep(wait);
        return restFetchMessages(channelId, params, token);
    }
    if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`Discord REST /messages error ${r.status}: ${body.slice(0, 300)}`);
    }
    return r.json();
}

interface GetHistoryArgs {
    channelId?: string;
    before?: string;
    after?: string;
    around?: string;
    since?: string;
    until?: string;
    from?: string;
    contains?: string;
    limit?: number;
    select?: string[];
    resolveReplies?: number;
}

/**
 * Paginated channel history via Discord REST. Walks newest→oldest in 100-msg
 * batches, applying client-side filters (`from`, `contains`, `since`/`until`)
 * since the REST endpoint doesn't natively support them. Returns oldest-first
 * so the agent can read it like a transcript, plus a `nextBefore` cursor for
 * deeper paging.
 *
 * `select` is field projection — defaults to the cheap set. Use it.
 */
async function bridgeGetHistory(args: GetHistoryArgs = {}): Promise<unknown> {
    const W = (globalThis as any).Vencord?.Webpack;
    if (!W?.findByProps) throw new Error("Vencord.Webpack is not ready yet.");

    const ChannelStore = W.findByProps("getChannel", "hasChannel");
    const SelectedChannelStore = W.findByProps("getChannelId", "getVoiceChannelId");

    const channelId = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel selected and no channelId provided.");
    const channel = ChannelStore?.getChannel?.(channelId);

    const token = getAuthToken(W);
    const selectKeys = new Set<string>(
        args.select?.length ? args.select : ["id", "content", "author", "timestamp"]
    );
    // resolveReplies needs `replyTo` in the projection — auto-add so callers
    // don't have to remember the dependency.
    const resolveDepth = Math.max(0, Math.min(20, args.resolveReplies ?? 0));
    if (resolveDepth > 0) selectKeys.add("replyTo");
    const limit = Math.max(1, Math.min(5000, args.limit ?? 200));

    // ISO → snowflake fallback for since/until when explicit before/after not set.
    let before = args.before || (args.until ? isoToSnowflake(args.until) : null) || undefined;
    const after = args.after || (args.since ? isoToSnowflake(args.since) : null) || undefined;

    const fromId = args.from || null;
    const containsLo = args.contains ? args.contains.toLowerCase() : null;
    const lowerBound = after ? BigInt(after) : null;

    const out: any[] = [];
    let cursor: string | undefined = before;
    let reachedEnd = false;
    let pages = 0;

    // Single-call `around` mode — Discord returns 50 each side; ignore paging.
    if (args.around && !cursor) {
        const batch = await restFetchMessages(channelId, { limit: 100, around: args.around }, token);
        for (const m of batch) {
            if (fromId && m.author?.id !== fromId) continue;
            if (containsLo && !(m.content || "").toLowerCase().includes(containsLo)) continue;
            out.push(projectMessage(m, selectKeys));
        }
        reachedEnd = true;
    } else {
        while (out.length < limit) {
            const params: Record<string, string | number> = { limit: 100 };
            if (cursor) params.before = cursor;
            const batch = await restFetchMessages(channelId, params, token);
            pages++;
            if (!batch.length) { reachedEnd = true; break; }

            let stop = false;
            for (const m of batch) {
                if (lowerBound && BigInt(m.id) <= lowerBound) { stop = true; continue; }
                if (fromId && m.author?.id !== fromId) continue;
                if (containsLo && !(m.content || "").toLowerCase().includes(containsLo)) continue;
                out.push(projectMessage(m, selectKeys));
                if (out.length >= limit) break;
            }
            cursor = batch[batch.length - 1].id;
            if (batch.length < 100) { reachedEnd = true; break; }
            if (stop) { reachedEnd = true; break; }
        }
    }

    // Currently newest-first → flip to oldest-first.
    out.reverse();

    // Inline reply-chain expansion (post-loop so we only walk for projected messages).
    if (resolveDepth > 0) {
        for (const m of out) {
            const startId = m.replyTo?.id;
            if (!startId) continue;
            try {
                m.replyChain = await walkReplyChain(
                    m.replyTo.channelId || channelId, startId, resolveDepth, W, token);
            } catch { /* */ }
        }
    }

    return {
        channel: channel ? {
            id: channel.id,
            name: channel.name || (channel.recipients?.length ? "(DM)" : null),
            type: channel.type,
            guildId: channel.guild_id || null,
        } : { id: channelId },
        count: out.length,
        pagesFetched: pages,
        hasMoreBefore: !reachedEnd,
        nextBefore: !reachedEnd ? cursor || null : null,
        oldestId: out[0]?.id || null,
        newestId: out[out.length - 1]?.id || null,
        messages: out,
    };
}

interface SearchArgs {
    channelId?: string;
    query: string;
    from?: string;
    mentions?: string;
    has?: string[];
    before?: string;
    after?: string;
    limit?: number;
}

/**
 * Wraps Discord's `/messages/search` endpoint. Uses the guild-level URL for
 * guild channels (with `channel_id=` constraint), channel-level for DMs/groups.
 * Auto-loops `offset` pagination up to `limit`. Surfaces indexing/rate-limit
 * responses so the caller can decide what to do.
 */
async function bridgeSearchMessages(args: SearchArgs): Promise<unknown> {
    const W = (globalThis as any).Vencord?.Webpack;
    if (!W?.findByProps) throw new Error("Vencord.Webpack is not ready yet.");
    if (!args.query || !args.query.trim()) throw new Error("`query` is required.");

    const ChannelStore = W.findByProps("getChannel", "hasChannel");
    const SelectedChannelStore = W.findByProps("getChannelId", "getVoiceChannelId");

    const channelId = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel selected and no channelId provided.");
    const channel = ChannelStore?.getChannel?.(channelId);
    const token = getAuthToken(W);
    const limit = Math.max(1, Math.min(200, args.limit ?? 25));

    const base = channel?.guild_id
        ? `https://discord.com/api/v9/guilds/${channel.guild_id}/messages/search`
        : `https://discord.com/api/v9/channels/${channelId}/messages/search`;

    const baseParams = new URLSearchParams();
    baseParams.set("content", args.query);
    if (channel?.guild_id) baseParams.set("channel_id", channelId);
    if (args.from) baseParams.set("author_id", args.from);
    if (args.mentions) baseParams.set("mentions", args.mentions);
    for (const h of args.has || []) baseParams.append("has", h);
    if (args.before) baseParams.set("max_id", args.before);
    if (args.after) baseParams.set("min_id", args.after);

    const collected: any[] = [];
    let totalResults = 0;
    let offset = 0;
    const selectKeys = new Set(["id", "content", "author", "timestamp", "attachments"]);

    while (collected.length < limit) {
        const p = new URLSearchParams(baseParams);
        p.set("offset", String(offset));
        const r = await fetch(`${base}?${p.toString()}`, { headers: { authorization: token } });

        if (r.status === 202) {
            const j = await r.json().catch(() => ({} as any));
            return {
                indexing: true,
                retryAfter: j.retry_after || null,
                message: "Discord is indexing this channel for search. Retry after `retryAfter` seconds.",
            };
        }
        if (r.status === 429) {
            const j = await r.json().catch(() => ({} as any));
            await sleep(Math.min(10_000, Math.max(250, (j.retry_after || 1) * 1000)));
            continue;
        }
        if (!r.ok) {
            const body = await r.text().catch(() => "");
            throw new Error(`Discord search error ${r.status}: ${body.slice(0, 300)}`);
        }

        const j: any = await r.json();
        totalResults = j.total_results ?? totalResults;
        if (!j.messages?.length) break;

        for (const group of j.messages) {
            const hit = group.find?.((m: any) => m.hit) || group[Math.floor(group.length / 2)] || group[0];
            if (!hit) continue;
            collected.push({ ...projectMessage(hit, selectKeys), hit: true });
            if (collected.length >= limit) break;
        }

        offset += j.messages.length;
        if (j.messages.length < 25) break;     // Discord page size — last page
    }

    return {
        channel: channel ? {
            id: channel.id,
            name: channel.name || (channel.recipients?.length ? "(DM)" : null),
            guildId: channel.guild_id || null,
        } : { id: channelId },
        query: args.query,
        totalResults,
        count: collected.length,
        messages: collected,
    };
}

/**
 * Strip-words list — PT + EN chat noise. Stored accent-stripped + lowercase;
 * words from messages are normalized the same way before lookup, so casual PT
 * typing ("nao", "voce", "ja") matches the canonical form ("não", "você", "já").
 */
const RAW_STOPWORDS = [
    // EN
    "the", "and", "for", "are", "but", "not", "you", "your", "yours", "with", "this", "that", "from", "have",
    "has", "had", "was", "were", "will", "would", "could", "should", "can", "may", "might", "just", "like",
    "what", "when", "where", "why", "how", "who", "which", "than", "then", "into", "over", "about", "out",
    "all", "any", "some", "one", "two", "get", "got", "going", "yeah", "yes", "ok", "okay", "lol", "haha",
    "really", "very", "much", "only", "also", "even", "still", "now", "here", "there", "their", "them",
    "they", "his", "her", "him", "she", "its", "our", "ours", "mine", "myself", "yourself",
    "been", "being", "does", "did", "doing", "done", "say", "said", "says", "see", "seen", "know", "knew",
    // PT
    "que", "para", "com", "como", "uma", "uns", "umas", "dos", "das", "nas", "nos", "por", "pelo", "pela",
    "pelos", "pelas", "sem", "mais", "menos", "muito", "muita", "muitos", "muitas", "tão", "também", "ainda",
    "agora", "depois", "antes", "sempre", "nunca", "aqui", "ali", "lá", "cá", "isto", "isso", "aquilo",
    "este", "esta", "esse", "essa", "aquele", "aquela", "estes", "estas", "esses", "essas", "aqueles", "aquelas",
    "meu", "minha", "meus", "minhas", "teu", "tua", "seu", "sua", "seus", "suas",
    "nosso", "nossa", "nossos", "nossas", "dele", "dela", "deles", "delas",
    "ser", "ter", "estar", "estou", "está", "estão", "estava", "estavam", "foi", "fui", "foram", "fosse",
    "são", "ele", "ela", "eles", "elas", "você", "vocês", "nós", "vós", "eu", "tu",
    "não", "sim", "então", "porque", "porquê", "pra", "pro", "tá", "tô", "né", "aí",
    "mas", "ou", "se", "já", "só", "vai", "vão", "vou", "vamos", "vem", "veio", "ver",
    "fazer", "feito", "faz", "fez", "ter", "tem", "tinha", "teve", "tive", "havia",
    "até", "onde", "qual", "quem", "quando",
];

const stripAccents = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const STOPWORDS = new Set<string>(RAW_STOPWORDS.map(w => stripAccents(w.toLowerCase())));

const URL_RE = /https?:\/\/([^\s/]+)/gi;
const WORD_RE = /[a-zA-ZÀ-ſ]{3,}/g;

interface StatsArgs {
    channelId?: string;
    since?: string;
    until?: string;
    groupBy?: "day" | "week" | "month";
    topN?: number;
    hardCap?: number;
}

function bucketOf(iso: string, groupBy: string): string {
    const d = new Date(iso);
    if (groupBy === "day") return d.toISOString().slice(0, 10);
    if (groupBy === "week") {
        const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
        const dayOfYear = Math.floor((d.getTime() - jan1) / 86_400_000) + 1;
        const week = Math.ceil(dayOfYear / 7);
        return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
    }
    return d.toISOString().slice(0, 7);            // month default
}

/**
 * Aggregate stats over a channel + time window. Same REST paging loop as
 * `bridgeGetHistory`, but the output is fixed-size (aggregates) regardless of
 * how many messages were scanned — safe for very large windows.
 *
 * `hardCap` (default 50000) bounds how many messages get scanned, in case the
 * window is wider than expected.
 */
async function bridgeGetStats(args: StatsArgs = {}): Promise<unknown> {
    const W = (globalThis as any).Vencord?.Webpack;
    if (!W?.findByProps) throw new Error("Vencord.Webpack is not ready yet.");

    const ChannelStore = W.findByProps("getChannel", "hasChannel");
    const SelectedChannelStore = W.findByProps("getChannelId", "getVoiceChannelId");
    const MessageStore = W.findByProps("getMessage", "getMessages");

    const channelId = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel selected and no channelId provided.");
    const channel = ChannelStore?.getChannel?.(channelId);

    const token = getAuthToken(W);
    const since = args.since ? isoToSnowflake(args.since) : null;
    const until = args.until ? isoToSnowflake(args.until) : null;
    const groupBy = args.groupBy || "month";
    const topN = Math.max(1, Math.min(100, args.topN ?? 10));
    const hardCap = Math.max(100, Math.min(200_000, args.hardCap ?? 50_000));

    // Page newest→oldest until we cross `since` or hit hardCap.
    const lower = since ? BigInt(since) : null;
    let cursor: string | undefined = until || undefined;
    let scanned = 0;
    let reachedEnd = false;
    let pages = 0;

    let attachments = 0, links = 0, replies = 0;
    const authorCount = new Map<string, number>();
    const authorName = new Map<string, string>();
    const bucketCount = new Map<string, number>();
    const replyEdges = new Map<string, number>();
    const domains = new Map<string, number>();
    const words = new Map<string, number>();
    // Same-window id→authorId map. Replies whose parent author isn't inlined
    // and isn't in MessageStore get resolved against this after paging ends.
    const authorById = new Map<string, string>();
    const pendingReplies: Array<{ from: string; refId: string; }> = [];
    let firstTs: string | null = null, lastTs: string | null = null;

    while (scanned < hardCap) {
        const params: Record<string, string | number> = { limit: 100 };
        if (cursor) params.before = cursor;
        const batch = await restFetchMessages(channelId, params, token);
        pages++;
        if (!batch.length) { reachedEnd = true; break; }

        let stop = false;
        for (const m of batch) {
            if (lower && BigInt(m.id) <= lower) { stop = true; break; }
            scanned++;
            const aid = m.author?.id;
            if (aid) {
                authorCount.set(aid, (authorCount.get(aid) || 0) + 1);
                if (!authorName.has(aid)) {
                    authorName.set(aid, m.author.global_name ?? m.author.globalName ?? m.author.username);
                }
                authorById.set(m.id, aid);
            }
            // Also index inlined parent (only set when REST returns it).
            const refAuthor = m.referenced_message?.author;
            if (refAuthor?.id) {
                authorById.set(m.referenced_message.id, refAuthor.id);
                if (!authorName.has(refAuthor.id)) {
                    authorName.set(refAuthor.id, refAuthor.global_name ?? refAuthor.globalName ?? refAuthor.username);
                }
            }
            const ts = m.timestamp || snowflakeToIso(m.id);
            if (ts) {
                if (!firstTs || ts < firstTs) firstTs = ts;
                if (!lastTs || ts > lastTs) lastTs = ts;
                bucketCount.set(bucketOf(ts, groupBy), (bucketCount.get(bucketOf(ts, groupBy)) || 0) + 1);
            }
            if (m.attachments?.length) attachments += m.attachments.length;
            if (m.message_reference?.message_id) {
                replies++;
                const refId = m.message_reference.message_id;
                const refChan = m.message_reference.channel_id || channelId;
                let toId: string | undefined =
                    m.referenced_message?.author?.id ||
                    authorById.get(refId) ||
                    MessageStore?.getMessage?.(refChan, refId)?.author?.id;
                if (aid && toId) {
                    const key = `${aid}→${toId}`;
                    replyEdges.set(key, (replyEdges.get(key) || 0) + 1);
                } else if (aid) {
                    // Parent message hasn't been scanned yet (older page) and
                    // isn't in MessageStore. Resolve after the loop finishes.
                    pendingReplies.push({ from: aid, refId });
                }
            }
            const content = m.content || "";
            const urlMatches = content.match(URL_RE) || [];
            for (const u of urlMatches) {
                links++;
                const dm = u.match(/https?:\/\/([^\s/]+)/i);
                if (dm) {
                    const host = dm[1].replace(/^www\./, "").toLowerCase();
                    domains.set(host, (domains.get(host) || 0) + 1);
                }
            }
            // Strip URLs before tokenizing so URL hosts/path words don't pollute topWords.
            const text = content.replace(/https?:\/\/\S+/gi, " ");
            const wmatches = text.toLowerCase().match(WORD_RE) || [];
            for (const w of wmatches) {
                const norm = stripAccents(w);
                if (STOPWORDS.has(norm)) continue;
                words.set(norm, (words.get(norm) || 0) + 1);
            }
        }
        cursor = batch[batch.length - 1].id;
        if (stop) { reachedEnd = true; break; }
        if (batch.length < 100) { reachedEnd = true; break; }
    }

    // Resolve replies whose parent message was paged in *after* the reply itself.
    for (const { from, refId } of pendingReplies) {
        const toId = authorById.get(refId);
        if (toId) {
            const key = `${from}→${toId}`;
            replyEdges.set(key, (replyEdges.get(key) || 0) + 1);
        }
    }

    const total = scanned;
    const rank = <T extends string>(m: Map<T, number>, n: number) =>
        [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

    return {
        channel: channel ? {
            id: channel.id,
            name: channel.name || (channel.recipients?.length ? "(DM)" : null),
            type: channel.type,
            guildId: channel.guild_id || null,
        } : { id: channelId },
        summary: {
            total,
            attachments,
            links,
            replies,
            distinctAuthors: authorCount.size,
            span: { firstTs, lastTs },
            windowSince: args.since || null,
            windowUntil: args.until || null,
            pagesFetched: pages,
            scanComplete: reachedEnd,
            hardCapHit: scanned >= hardCap,
        },
        byAuthor: rank(authorCount, topN).map(([id, count]) => ({
            id,
            name: authorName.get(id) || null,
            count,
            pct: total ? +(count / total * 100).toFixed(1) : 0,
        })),
        byBucket: [...bucketCount.entries()]
            .sort((a, b) => (a[0] < b[0] ? -1 : 1))
            .map(([bucket, count]) => ({ bucket, count })),
        replyEdges: rank(replyEdges, topN).map(([key, count]) => {
            const [from, to] = key.split("→");
            return {
                from, fromName: authorName.get(from) || null,
                to, toName: authorName.get(to) || null,
                count,
            };
        }),
        topDomains: rank(domains, topN).map(([domain, count]) => ({ domain, count })),
        topWords: rank(words, topN).map(([word, count]) => ({ word, count })),
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

/* --------------------------------------- react / edit / delete / pins -- */

interface ReactArgs {
    channelId?: string;
    messageId: string;
    emoji: string;
    action?: "add" | "remove";
}

/** Parse "<:name:id>", "<a:name:id>", or raw unicode → emoji descriptor for Discord's reaction API. */
function parseEmoji(input: string): { name: string; id: string | null; animated?: boolean } {
    const m = input.match(/^<(a?):([^:]+):(\d+)>$/);
    if (m) return { name: m[2], id: m[3], animated: !!m[1] };
    const s = input.trim();
    if (!s) throw new Error("Empty emoji.");
    if (/^:[^:]+:$/.test(s))
        throw new Error(
            `Shortcode ${s} not supported — pass raw unicode (e.g. "👍") or the full "<:name:id>" / "<a:name:id>" form.`);
    return { name: s, id: null };
}

/**
 * Add or remove a reaction on a message. Uses Discord's internal
 * `ReactionActions.addReaction` / `removeReaction` — the same code path the
 * reaction picker uses. Pre-validates the messageId against MessageStore so a
 * fabricated ID fails loudly instead of silently no-op-ing.
 */
async function bridgeReact(args: ReactArgs): Promise<unknown> {
    const W = (globalThis as any).Vencord?.Webpack;
    if (!W?.findByProps) throw new Error("Vencord.Webpack is not ready yet.");

    const SelectedChannelStore = W.findByProps("getChannelId", "getVoiceChannelId");
    const ChannelStore = W.findByProps("getChannel", "hasChannel");
    const MessageStore = W.findByProps("getMessage", "getMessages");
    const UserStore = W.findByProps("getCurrentUser", "getUser");

    const channelId = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel selected and no channelId provided.");
    if (!args.messageId) throw new Error("`messageId` is required.");
    if (!args.emoji) throw new Error("`emoji` is required.");
    const channel = ChannelStore?.getChannel?.(channelId);
    if (!channel) throw new Error("Channel not found: " + channelId);

    const stored = MessageStore?.getMessage?.(channelId, args.messageId);
    if (!stored)
        throw new Error(
            `messageId ${args.messageId} not found in channel ${channelId}'s local message store. ` +
            "Pull message IDs from a fresh discord_view result for this channel.");

    const emoji = parseEmoji(args.emoji);
    const action = args.action ?? "add";
    if (action !== "add" && action !== "remove")
        throw new Error("`action` must be 'add' or 'remove'.");

    // The reaction action module's property names are minified and change between
    // Discord builds, so we can't rely on findByProps("addReaction", …). Locate the
    // module by the dispatch type strings its functions emit, then identify add vs
    // remove by which dispatch type appears in each function's source.
    const reactionMod = W.find((m: any) =>
        m && typeof m === "object"
        && Object.values(m).some((v: any) => typeof v === "function" && /"MESSAGE_REACTION_ADD"/.test(v.toString()))
        && Object.values(m).some((v: any) => typeof v === "function" && /"MESSAGE_REACTION_REMOVE"/.test(v.toString())));
    if (!reactionMod) throw new Error(
        "Reaction actions module not found — webpack module shape may have changed.");

    // Both add and remove functions reference BOTH dispatch types in their source
    // (error/retry paths), so a simple "contains ADD but not REMOVE" filter fails.
    // Distinguish by which dispatch type appears *first* — that's the one the
    // function actually fires on its happy path.
    let addFn: ((...a: unknown[]) => unknown) | undefined;
    let removeFn: ((...a: unknown[]) => unknown) | undefined;
    for (const v of Object.values(reactionMod) as any[]) {
        if (typeof v !== "function") continue;
        const src = v.toString();
        const addIdx = src.indexOf('"MESSAGE_REACTION_ADD"');
        const removeIdx = src.indexOf('"MESSAGE_REACTION_REMOVE"');
        if (addIdx < 0 && removeIdx < 0) continue;
        const firesAddFirst = addIdx >= 0 && (removeIdx < 0 || addIdx < removeIdx);
        const firesRemoveFirst = removeIdx >= 0 && (addIdx < 0 || removeIdx < addIdx);
        if (firesAddFirst && !addFn) addFn = v;
        else if (firesRemoveFirst && !removeFn) removeFn = v;
    }
    if (action === "add" && !addFn) throw new Error("Add-reaction function not found in reaction module.");
    if (action === "remove" && !removeFn) throw new Error("Remove-reaction function not found in reaction module.");

    if (action === "add") {
        // Positional signature: (channelId, messageId, emoji, location?, options?)
        await addFn!(channelId, args.messageId, emoji);
    } else {
        // Single-object signature: ({channelId, messageId, emoji, location, userId, options})
        const userId = UserStore?.getCurrentUser?.()?.id;
        if (!userId) throw new Error("Could not resolve current user ID for reaction removal.");
        await removeFn!({ channelId, messageId: args.messageId, emoji, location: "Message", userId });
    }

    return {
        ok: true,
        channelId,
        messageId: args.messageId,
        emoji: emoji.id ? `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>` : emoji.name,
        action,
    };
}

interface EditArgs {
    channelId?: string;
    messageId: string;
    content: string;
}

/** Edit one of the viewer's own messages. Refuses to touch other users' messages. */
async function bridgeEdit(args: EditArgs): Promise<unknown> {
    const W = (globalThis as any).Vencord?.Webpack;
    if (!W?.findByProps) throw new Error("Vencord.Webpack is not ready yet.");

    const SelectedChannelStore = W.findByProps("getChannelId", "getVoiceChannelId");
    const MessageStore = W.findByProps("getMessage", "getMessages");
    const UserStore = W.findByProps("getCurrentUser", "getUser");
    const MessageActions = W.findByProps("sendMessage", "editMessage");

    const channelId = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel selected and no channelId provided.");
    if (!args.messageId) throw new Error("`messageId` is required.");
    if (typeof args.content !== "string") throw new Error("`content` is required.");

    const stored = MessageStore?.getMessage?.(channelId, args.messageId);
    if (!stored)
        throw new Error(
            `messageId ${args.messageId} not found in channel ${channelId}'s local message store. ` +
            "Pull message IDs from a fresh discord_view result for this channel.");

    const viewer = UserStore?.getCurrentUser?.();
    if (!viewer) throw new Error("Current user unavailable from UserStore.");
    if (stored.author?.id !== viewer.id)
        throw new Error(
            `Cannot edit message ${args.messageId}: author is ${stored.author?.id} but viewer is ${viewer.id}. ` +
            "Discord only allows editing your own messages.");

    if (!MessageActions?.editMessage)
        throw new Error("MessageActions.editMessage not found — webpack module shape may have changed.");
    await MessageActions.editMessage(channelId, args.messageId, { content: args.content });

    return { ok: true, channelId, messageId: args.messageId, content: args.content };
}

interface DeleteArgs {
    channelId?: string;
    messageId: string;
}

/**
 * Delete one of the viewer's own messages. Author check + pre-validation only —
 * destructive, but the tool description and the model's general "don't delete
 * without explicit instruction" caution carry the rest.
 */
async function bridgeDelete(args: DeleteArgs): Promise<unknown> {
    const W = (globalThis as any).Vencord?.Webpack;
    if (!W?.findByProps) throw new Error("Vencord.Webpack is not ready yet.");

    const SelectedChannelStore = W.findByProps("getChannelId", "getVoiceChannelId");
    const MessageStore = W.findByProps("getMessage", "getMessages");
    const UserStore = W.findByProps("getCurrentUser", "getUser");
    const MessageActions = W.findByProps("sendMessage", "editMessage");

    const channelId = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel selected and no channelId provided.");
    if (!args.messageId) throw new Error("`messageId` is required.");

    const stored = MessageStore?.getMessage?.(channelId, args.messageId);
    if (!stored)
        throw new Error(
            `messageId ${args.messageId} not found in channel ${channelId}'s local message store. ` +
            "Pull message IDs from a fresh discord_view result for this channel.");

    const viewer = UserStore?.getCurrentUser?.();
    if (!viewer) throw new Error("Current user unavailable from UserStore.");
    if (stored.author?.id !== viewer.id)
        throw new Error(
            `Cannot delete message ${args.messageId}: author is ${stored.author?.id} but viewer is ${viewer.id}. ` +
            "Discord only allows deleting your own messages.");

    if (!MessageActions?.deleteMessage)
        throw new Error("MessageActions.deleteMessage not found — webpack module shape may have changed.");
    await MessageActions.deleteMessage(channelId, args.messageId);

    return {
        ok: true,
        channelId,
        messageId: args.messageId,
        deletedContentPreview: (stored.content || "").slice(0, 200),
    };
}

interface PinsArgs {
    channelId?: string;
    select?: string[];
}

/** List pinned messages in a channel via REST. Pins are usually the channel's thesis — cheap context, huge signal. */
async function bridgePins(args: PinsArgs = {}): Promise<unknown> {
    const W = (globalThis as any).Vencord?.Webpack;
    if (!W?.findByProps) throw new Error("Vencord.Webpack is not ready yet.");

    const ChannelStore = W.findByProps("getChannel", "hasChannel");
    const SelectedChannelStore = W.findByProps("getChannelId", "getVoiceChannelId");

    const channelId = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel selected and no channelId provided.");
    const channel = ChannelStore?.getChannel?.(channelId);
    const token = getAuthToken(W);

    const r = await fetch(`https://discord.com/api/v9/channels/${channelId}/pins`, {
        headers: { authorization: token },
    });
    if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`Discord REST /pins error ${r.status}: ${body.slice(0, 300)}`);
    }
    const raw: any[] = await r.json();
    const select = new Set<string>(
        args.select?.length ? args.select : ["id", "content", "author", "timestamp"]
    );

    return {
        channel: channel ? {
            id: channel.id,
            name: channel.name || (channel.recipients?.length ? "(DM)" : null),
            guildId: channel.guild_id || null,
        } : { id: channelId },
        count: raw.length,
        messages: raw.map(m => projectMessage(m, select)),
    };
}

/* ------------------------------------------------------------- threads -- */

interface ThreadsArgs {
    channelId?: string;
    includeArchived?: boolean;
    archivedLimit?: number;
}

/**
 * List threads (active + archived public) under a parent channel. Threads are
 * first-class channels in Discord — the bridge otherwise treats them as
 * invisible. For guild channels, active threads come from the guild-level
 * endpoint and are filtered to this parent.
 */
async function bridgeThreads(args: ThreadsArgs = {}): Promise<unknown> {
    const W = (globalThis as any).Vencord?.Webpack;
    if (!W?.findByProps) throw new Error("Vencord.Webpack is not ready yet.");

    const ChannelStore = W.findByProps("getChannel", "hasChannel");
    const SelectedChannelStore = W.findByProps("getChannelId", "getVoiceChannelId");

    const channelId = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel selected and no channelId provided.");
    const channel = ChannelStore?.getChannel?.(channelId);
    const token = getAuthToken(W);
    const archivedLimit = Math.max(1, Math.min(100, args.archivedLimit ?? 25));

    const projectThread = (t: any) => ({
        id: t.id,
        name: t.name,
        type: t.type,
        parentId: t.parent_id ?? t.parentId,
        archived: !!(t.thread_metadata?.archived ?? t.threadMetadata?.archived),
        locked: !!(t.thread_metadata?.locked ?? t.threadMetadata?.locked),
        autoArchiveDuration:
            t.thread_metadata?.auto_archive_duration ?? t.threadMetadata?.autoArchiveDuration ?? null,
        archiveTimestamp:
            t.thread_metadata?.archive_timestamp ?? t.threadMetadata?.archiveTimestamp ?? null,
        memberCount: t.member_count ?? t.memberCount ?? null,
        messageCount: t.message_count ?? t.messageCount ?? null,
        ownerId: t.owner_id ?? t.ownerId ?? null,
    });

    // If the supplied channel IS a thread, treat its parent as the listing target.
    const isThread = channel && [10, 11, 12].includes(channel.type);
    const parentForLookup = isThread ? (channel.parent_id || channelId) : channelId;
    const guildId = channel?.guild_id;

    const active: any[] = [];
    if (guildId) {
        try {
            const r = await fetch(`https://discord.com/api/v9/guilds/${guildId}/threads/active`, {
                headers: { authorization: token },
            });
            if (r.ok) {
                const j: any = await r.json();
                for (const t of j.threads || []) {
                    if ((t.parent_id || t.parentId) === parentForLookup) active.push(projectThread(t));
                }
            }
        } catch { /* */ }
    }

    let archived: any[] = [];
    if (args.includeArchived ?? true) {
        try {
            const r = await fetch(
                `https://discord.com/api/v9/channels/${parentForLookup}/threads/archived/public?limit=${archivedLimit}`,
                { headers: { authorization: token } });
            if (r.ok) {
                const j: any = await r.json();
                archived = (j.threads || []).map(projectThread);
            }
        } catch { /* */ }
    }

    return {
        channel: channel ? {
            id: channel.id,
            name: channel.name || null,
            type: channel.type,
            guildId: guildId || null,
        } : { id: channelId },
        parentId: parentForLookup,
        activeCount: active.length,
        archivedCount: archived.length,
        threads: { active, archived },
    };
}

/* ---------------------------------------------- member / user profile -- */

interface MemberArgs { userId: string; }

/**
 * Lookup a user's full profile: REST `/users/{id}/profile` for bio/pronouns/
 * mutual guilds, PresenceStore for status + activities. Useful for
 * disambiguation ("which Igor?"), tone calibration, and addressing by
 * `globalName` instead of username.
 */
async function bridgeMember(args: MemberArgs): Promise<unknown> {
    const W = (globalThis as any).Vencord?.Webpack;
    if (!W?.findByProps) throw new Error("Vencord.Webpack is not ready yet.");
    if (!args.userId) throw new Error("`userId` is required.");

    const UserStore = W.findByProps("getCurrentUser", "getUser");
    const PresenceStore = W.findByProps("getStatus", "getActivities")
        ?? W.findByProps("getStatus", "isMobileOnline");

    const token = getAuthToken(W);
    let profile: any = null;
    try {
        const r = await fetch(
            `https://discord.com/api/v9/users/${args.userId}/profile?with_mutual_guilds=true`,
            { headers: { authorization: token } });
        if (r.ok) profile = await r.json();
        else if (r.status === 404) throw new Error("User not found: " + args.userId);
        else if (r.status === 403) {
            // Some users (e.g. via DM-blocked) return 403 — fall through to UserStore.
        }
    } catch (e: any) {
        if (typeof e?.message === "string" && e.message.startsWith("User not found")) throw e;
        // network error — fall through
    }

    const u = profile?.user ?? UserStore?.getUser?.(args.userId);
    if (!u)
        throw new Error(
            "User not found via profile API or UserStore: " + args.userId +
            ". The user may not share any context with you.");

    const renderName = (x: any) => x?.global_name ?? x?.globalName ?? x?.username ?? null;
    const avatarUrl = u.avatar
        ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${u.avatar.startsWith("a_") ? "gif" : "png"}?size=256`
        : null;
    const createdAtMs = Number((BigInt(u.id) >> 22n) + DISCORD_EPOCH);

    const status = PresenceStore?.getStatus?.(args.userId) || null;
    const activities = (PresenceStore?.getActivities?.(args.userId) || []).map((a: any) => ({
        name: a.name,
        type: a.type,
        state: a.state,
        details: a.details,
        applicationId: a.application_id ?? a.applicationId,
    }));
    const mutualGuilds = (profile?.mutual_guilds || []).map(
        (g: any) => ({ id: g.id, nick: g.nick || null }));

    return {
        id: u.id,
        username: u.username,
        globalName: renderName(u),
        discriminator: u.discriminator && u.discriminator !== "0" ? u.discriminator : undefined,
        avatarUrl,
        bot: !!u.bot,
        createdAt: new Date(createdAtMs).toISOString(),
        bio: profile?.user_profile?.bio || null,
        pronouns: profile?.user_profile?.pronouns || null,
        accentColor: profile?.user_profile?.accent_color ?? null,
        status,
        activities,
        mutualGuilds,
        mutualGuildCount: mutualGuilds.length,
    };
}

/* ------------------------------------------------------- unread / ack --- */

interface UnreadArgs {
    includeGuilds?: boolean;
    mentionsOnly?: boolean;
    limit?: number;
}

/**
 * Enumerate channels with unread messages. Walks DMs (always) and guild text
 * channels (when `includeGuilds`). For each, asks ReadStateStore for unread
 * count + mention count + oldest unread id.
 */
function bridgeUnread(args: UnreadArgs = {}): unknown {
    const W = (globalThis as any).Vencord?.Webpack;
    if (!W?.findByProps) throw new Error("Vencord.Webpack is not ready yet.");

    const ChannelStore = W.findByProps("getChannel", "hasChannel");
    const ReadStateStore = W.findByProps("getUnreadCount", "getMentionCount")
        ?? W.findByProps("hasUnread", "getUnreadCount");
    const SortStore = W.findByProps("getPrivateChannelIds")
        ?? W.findByProps("getSortedPrivateChannels");
    const GuildStore = W.findByProps("getGuild", "getGuilds");
    const GuildChannelStore = W.findByProps("getChannels", "getDefaultChannel")
        ?? W.findByProps("getChannels");
    const UserStore = W.findByProps("getCurrentUser", "getUser");
    const RelationshipStore = W.findByProps("getRelationshipType", "isFriend");

    if (!ReadStateStore) throw new Error("ReadStateStore not found.");

    const renderName = (u: any) => u?.globalName ?? u?.global_name ?? u?.username ?? null;
    const limit = Math.max(1, Math.min(500, args.limit ?? 100));
    const mentionsOnly = !!args.mentionsOnly;

    const channelIds: string[] = [];
    if (typeof SortStore?.getPrivateChannelIds === "function") {
        channelIds.push(...SortStore.getPrivateChannelIds());
    } else if (typeof ChannelStore?.getSortedPrivateChannels === "function") {
        channelIds.push(...ChannelStore.getSortedPrivateChannels().map((c: any) => c.id));
    }

    if (args.includeGuilds && GuildStore && GuildChannelStore?.getChannels) {
        for (const gid of Object.keys(GuildStore.getGuilds() || {})) {
            const groups = GuildChannelStore.getChannels(gid);
            const selectable = groups?.SELECTABLE || groups?.selectable || [];
            for (const entry of selectable) {
                const ch = entry.channel || entry;
                if (ch?.id) channelIds.push(ch.id);
            }
        }
    }

    const out: any[] = [];
    let totalUnread = 0;
    let totalMentions = 0;
    for (const cid of channelIds) {
        const mentions = ReadStateStore.getMentionCount?.(cid) || 0;
        const unread = ReadStateStore.getUnreadCount?.(cid) || 0;
        const has = ReadStateStore.hasUnread?.(cid);
        if (!unread && !mentions && !has) continue;
        if (mentionsOnly && !mentions) continue;
        totalUnread += unread;
        totalMentions += mentions;
        const ch = ChannelStore?.getChannel?.(cid);
        const oldest = ReadStateStore.getOldestUnreadMessageId?.(cid) || null;
        const lastRead = ReadStateStore.lastMessageId?.(cid) || null;
        const isDm = ch && (ch.type === 1 || ch.type === 3);
        let name = ch?.name || null;
        if (isDm) {
            const recipientIds: string[] = ch.recipients || ch.recipientIds || [];
            const first = recipientIds[0];
            const u = first ? UserStore?.getUser?.(first) : null;
            const nick = first ? RelationshipStore?.getNickname?.(first) : null;
            if (ch.type === 1) name = nick || renderName(u) || "(dm)";
            else name = ch.name || (recipientIds.map(id => {
                const cu = UserStore?.getUser?.(id);
                return RelationshipStore?.getNickname?.(id) || renderName(cu);
            }).filter(Boolean).join(", ") || "(group)");
        }
        out.push({
            channelId: cid,
            kind: ch?.type === 1 ? "dm" : ch?.type === 3 ? "group" : "guild",
            name,
            guildId: ch?.guild_id || null,
            guildName: ch?.guild_id ? GuildStore?.getGuild?.(ch.guild_id)?.name ?? null : null,
            unreadCount: unread,
            mentionCount: mentions,
            oldestUnreadId: oldest,
            lastReadMessageId: lastRead,
        });
    }

    out.sort((a, b) => (b.mentionCount - a.mentionCount) || (b.unreadCount - a.unreadCount));
    return {
        channelsScanned: channelIds.length,
        totalUnread,
        totalMentions,
        count: out.length,
        channels: out.slice(0, limit),
    };
}

interface AckArgs {
    channelId: string;
    messageId?: string;
}

/**
 * Mark a channel read up to a given message. REST:
 * `POST /channels/{id}/messages/{messageId}/ack` with `{ token: null, manual: true }`.
 * If `messageId` omitted, acks the channel's most recent message.
 */
async function bridgeAck(args: AckArgs): Promise<unknown> {
    const W = (globalThis as any).Vencord?.Webpack;
    if (!W?.findByProps) throw new Error("Vencord.Webpack is not ready yet.");
    if (!args.channelId) throw new Error("`channelId` is required.");

    const ChannelStore = W.findByProps("getChannel", "hasChannel");
    const ReadStateStore = W.findByProps("getUnreadCount", "getMentionCount")
        ?? W.findByProps("hasUnread", "getUnreadCount");
    const MessageStore = W.findByProps("getMessage", "getMessages");

    const token = getAuthToken(W);

    let mid = args.messageId;
    if (!mid) {
        const msgs = MessageStore?.getMessages?.(args.channelId);
        const last = msgs?._array?.[msgs._array.length - 1]
            ?? msgs?.toArray?.()?.slice(-1)[0]
            ?? null;
        mid = last?.id || ReadStateStore?.lastMessageId?.(args.channelId);
        if (!mid) {
            // REST fallback — fetch the newest message id.
            const batch = await restFetchMessages(args.channelId, { limit: 1 }, token);
            mid = batch[0]?.id;
        }
    }
    if (!mid) throw new Error("Could not determine a messageId to ack (channel may be empty).");

    const r = await fetch(
        `https://discord.com/api/v9/channels/${args.channelId}/messages/${mid}/ack`,
        {
            method: "POST",
            headers: { authorization: token, "content-type": "application/json" },
            body: JSON.stringify({ token: null, manual: true }),
        });
    if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`Discord REST /ack error ${r.status}: ${text.slice(0, 300)}`);
    }
    const ch = ChannelStore?.getChannel?.(args.channelId);
    return {
        ok: true,
        channelId: args.channelId,
        ackedMessageId: mid,
        channel: ch ? {
            id: ch.id,
            name: ch.name || null,
            guildId: ch.guild_id || null,
        } : null,
    };
}

/* ------------------------------------------------------- emoji ---------- */

interface EmojiArgs {
    query?: string;
    guildId?: string;
    limit?: number;
}

/**
 * List/search custom server emoji across the user's guilds. Returns each as
 * `{ shortcode }` ready to paste into `discord_send` content or use directly
 * with `discord_react`'s `<:name:id>` form.
 */
function bridgeEmoji(args: EmojiArgs = {}): unknown {
    const W = (globalThis as any).Vencord?.Webpack;
    if (!W?.findByProps) throw new Error("Vencord.Webpack is not ready yet.");

    const EmojiStore = W.findByProps("getGuilds", "getDisambiguatedEmojiContext")
        ?? W.findByProps("getCustomEmojiById", "getUsableCustomEmoji")
        ?? W.findByProps("getGuildEmoji");
    const GuildStore = W.findByProps("getGuild", "getGuilds");

    if (!EmojiStore) throw new Error("EmojiStore not found — webpack module shape may have changed.");

    let guildsMap: Record<string, any> = {};
    if (typeof EmojiStore.getGuilds === "function") {
        guildsMap = EmojiStore.getGuilds() || {};
    } else if (typeof EmojiStore.getGuildEmoji === "function" && typeof GuildStore?.getGuilds === "function") {
        for (const gid of Object.keys(GuildStore.getGuilds())) {
            const emojis = EmojiStore.getGuildEmoji(gid);
            if (emojis?.length) guildsMap[gid] = { emojis };
        }
    } else {
        throw new Error("EmojiStore has no recognized listing method.");
    }

    const q = (args.query || "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, args.limit ?? 25));

    const score = (name: string) => {
        if (!q) return 0;
        const lo = name.toLowerCase();
        if (lo === q) return 100;
        if (lo.startsWith(q)) return 75;
        if (lo.includes(q)) return 50;
        return -1;
    };

    const out: Array<{ name: string; id: string; animated: boolean; guildId: string; guildName: string | null; url: string; shortcode: string; _score: number; }> = [];
    for (const [gid, g] of Object.entries(guildsMap)) {
        if (args.guildId && gid !== args.guildId) continue;
        const guildName = GuildStore?.getGuild?.(gid)?.name ?? null;
        for (const e of (g as any).emojis || []) {
            const s = score(e.name);
            if (q && s < 0) continue;
            out.push({
                name: e.name,
                id: e.id,
                animated: !!e.animated,
                guildId: gid,
                guildName,
                url: `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? "gif" : "png"}?size=96`,
                shortcode: `<${e.animated ? "a" : ""}:${e.name}:${e.id}>`,
                _score: s,
            });
        }
    }

    out.sort((a, b) => b._score - a._score || a.name.localeCompare(b.name));
    return {
        total: out.length,
        query: q || undefined,
        emojis: out.slice(0, limit).map(({ _score, ...rest }) => rest),
    };
}

/* ------------------------------------------------------- dm open --------- */

interface DmOpenArgs {
    userId?: string;
    userIds?: string[];
}

/**
 * Start a DM (or group DM) with a user not yet in the sidebar.
 * REST: `POST /users/@me/channels` with `{ recipient_id }` or `{ recipients: [] }`.
 * Returns the channel info in the same shape as `discord_dms` so the result
 * pipes straight into `discord_send`.
 */
async function bridgeDmOpen(args: DmOpenArgs): Promise<unknown> {
    const W = (globalThis as any).Vencord?.Webpack;
    if (!W?.findByProps) throw new Error("Vencord.Webpack is not ready yet.");

    const ids = args.userIds?.length ? args.userIds : (args.userId ? [args.userId] : []);
    if (!ids.length) throw new Error("Provide `userId` or `userIds`.");

    const token = getAuthToken(W);
    const body = ids.length === 1
        ? { recipient_id: ids[0] }
        : { recipients: ids };

    const r = await fetch("https://discord.com/api/v9/users/@me/channels", {
        method: "POST",
        headers: { authorization: token, "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`Discord REST /users/@me/channels error ${r.status}: ${text.slice(0, 300)}`);
    }
    const ch: any = await r.json();

    const UserStore = W.findByProps("getCurrentUser", "getUser");
    const RelationshipStore = W.findByProps("getRelationshipType", "isFriend");
    const renderName = (u: any) => u?.global_name ?? u?.globalName ?? u?.username ?? null;

    const recipients = (ch.recipients || []).map((u: any) => {
        const cached = UserStore?.getUser?.(u.id);
        const nickname = RelationshipStore?.getNickname?.(u.id) || null;
        return {
            id: u.id,
            username: u.username || cached?.username,
            name: renderName(u) || renderName(cached),
            nickname,
            bot: !!(u.bot ?? cached?.bot),
        };
    });
    const isGroup = ch.type === 3;
    const name = isGroup
        ? (ch.name || recipients.map((r: any) => r.nickname || r.name || r.username).filter(Boolean).join(", ") || "(group)")
        : (recipients[0]?.nickname || recipients[0]?.name || recipients[0]?.username || "(unknown)");

    return {
        channelId: ch.id,
        kind: isGroup ? "group" : "dm",
        name,
        memberCount: isGroup ? recipients.length : undefined,
        recipients,
    };
}

/* ------------------------------------------------------- attachment ------ */

interface AttachmentArgs {
    channelId?: string;
    messageId: string;
    index?: number;
}

/**
 * Return attachment metadata for a message. The MCP server does the actual
 * CDN fetch — keeps the bytes off the /eval payload (which is capped at 600 KB
 * for sanity). Discord's CDN URLs are signed (`ex`/`is`/`hm` query params) and
 * work from anywhere — no auth needed on the WSL side.
 */
async function bridgeAttachment(args: AttachmentArgs): Promise<unknown> {
    const W = (globalThis as any).Vencord?.Webpack;
    if (!W?.findByProps) throw new Error("Vencord.Webpack is not ready yet.");

    const SelectedChannelStore = W.findByProps("getChannelId", "getVoiceChannelId");
    const MessageStore = W.findByProps("getMessage", "getMessages");

    const channelId = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel selected and no channelId provided.");
    if (!args.messageId) throw new Error("`messageId` is required.");

    const token = getAuthToken(W);
    const msg = await fetchMessageById(channelId, args.messageId, W, token);
    if (!msg)
        throw new Error(`messageId ${args.messageId} not found in channel ${channelId}.`);

    const attachments: any[] = msg.attachments || [];
    if (!attachments.length)
        throw new Error(`message ${args.messageId} has no attachments.`);

    const idx = Math.max(0, Math.min(attachments.length - 1, args.index ?? 0));
    const a = attachments[idx];
    return {
        index: idx,
        attachmentCount: attachments.length,
        name: a.filename || a.name,
        url: a.url,
        proxyUrl: a.proxy_url || a.proxyUrl || null,
        size: a.size,
        contentType: a.content_type || a.contentType || null,
        width: a.width ?? null,
        height: a.height ?? null,
    };
}

/* ----------------------- reply-chain walker + resolveMessage --------------- */

interface ResolveMessageArgs {
    channelId?: string;
    messageId: string;
    depth?: number;
}

const renderUserName = (u: any) => u?.global_name ?? u?.globalName ?? u?.username ?? null;

function compactMessage(msg: any): any {
    const tsIso = (t: any) =>
        typeof t?.toISOString === "function" ? t.toISOString() : (t ? String(t) : null);
    return {
        id: msg.id,
        timestamp: tsIso(msg.timestamp) ?? msg.timestamp ?? null,
        author: msg.author ? {
            id: msg.author.id,
            username: msg.author.username,
            name: renderUserName(msg.author),
            bot: !!msg.author.bot,
        } : null,
        content: (msg.content || "").slice(0, 800),
    };
}

async function fetchMessageById(channelId: string, messageId: string, W: any, token: string): Promise<any | null> {
    const MessageStore = W.findByProps("getMessage", "getMessages");
    const cached = MessageStore?.getMessage?.(channelId, messageId);
    if (cached) return cached;
    try {
        const batch = await restFetchMessages(channelId, { limit: 1, around: messageId }, token);
        return batch.find((m: any) => m.id === messageId) || null;
    } catch { return null; }
}

/** Walk a reply chain N parents starting at messageId. Returns oldest→newest. */
async function walkReplyChain(
    channelId: string, messageId: string, depth: number, W: any, token: string
): Promise<any[]> {
    const chain: any[] = [];
    let nextChan = channelId;
    let nextId: string | undefined = messageId;
    const seen = new Set<string>();
    for (let i = 0; i < depth && nextId; i++) {
        const key = nextChan + "/" + nextId;
        if (seen.has(key)) break;
        seen.add(key);
        const msg = await fetchMessageById(nextChan, nextId, W, token);
        if (!msg) { chain.push({ id: nextId, unloaded: true }); break; }
        chain.push(compactMessage(msg));
        const ref = msg.messageReference || msg.message_reference;
        if (!ref?.message_id) break;
        nextChan = ref.channel_id || nextChan;
        nextId = ref.message_id;
    }
    return chain.reverse();
}

/** Fetch one message + its parent chain (depth N). Useful when a `replyTo.id` from another tool is unresolved. */
async function bridgeResolveMessage(args: ResolveMessageArgs): Promise<unknown> {
    const W = (globalThis as any).Vencord?.Webpack;
    if (!W?.findByProps) throw new Error("Vencord.Webpack is not ready yet.");

    const SelectedChannelStore = W.findByProps("getChannelId", "getVoiceChannelId");
    const ChannelStore = W.findByProps("getChannel", "hasChannel");

    const channelId = args.channelId || SelectedChannelStore?.getChannelId?.();
    if (!channelId) throw new Error("No channel selected and no channelId provided.");
    if (!args.messageId) throw new Error("`messageId` is required.");

    const token = getAuthToken(W);
    const msg = await fetchMessageById(channelId, args.messageId, W, token);
    if (!msg) throw new Error(`messageId ${args.messageId} not found in channel ${channelId}.`);

    const depth = Math.max(0, Math.min(20, args.depth ?? 5));
    const ref = msg.messageReference || msg.message_reference;
    const chain = ref?.message_id
        ? await walkReplyChain(ref.channel_id || channelId, ref.message_id, depth, W, token)
        : [];

    const channel = ChannelStore?.getChannel?.(channelId);
    const projectKeys = new Set(["id", "content", "author", "timestamp", "attachments", "replyTo", "mentions", "reactions", "edited"]);
    return {
        channel: channel ? {
            id: channel.id,
            name: channel.name || (channel.recipients?.length ? "(DM)" : null),
            guildId: channel.guild_id || null,
        } : { id: channelId },
        message: projectMessage(msg, projectKeys),
        replyChain: chain,
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
    name: "DiscordMCP",
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
            version: 23,
            console: consoleBuffer,
            isConnected: () => connected,
            isActive: () => settings.store.bridgeActive,
            sendMessage: bridgeSendMessage,
            getView: bridgeGetView,
            listDMs: bridgeListDMs,
            openChannel: bridgeOpenChannel,
            getHistory: bridgeGetHistory,
            searchMessages: bridgeSearchMessages,
            getStats: bridgeGetStats,
            react: bridgeReact,
            editMessage: bridgeEdit,
            deleteMessage: bridgeDelete,
            getPins: bridgePins,
            getThreads: bridgeThreads,
            getMember: bridgeMember,
            resolveMessage: bridgeResolveMessage,
            attachment: bridgeAttachment,
            dmOpen: bridgeDmOpen,
            listEmoji: bridgeEmoji,
            unread: bridgeUnread,
            ack: bridgeAck,
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
