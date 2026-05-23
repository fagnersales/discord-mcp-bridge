#!/usr/bin/env bun
/**
 * discord-bridge MCP server (per-session client)
 * ----------------------------------------------
 * A thin MCP stdio server. Claude Code spawns one of these per session.
 *
 * It owns NO port. Every tool call is proxied over HTTP to the long-lived
 * daemon (daemon.ts) that owns :8787 and the Discord connection. On startup it
 * ensures the daemon is running, spawning it detached (via `setsid`) if not.
 *
 * This decouples the two roles that used to live in one file: any number of
 * Claude Code sessions can each run one of these harmlessly — they all share
 * the single daemon, so the discord_* tools always connect.
 *
 * IMPORTANT: stdout is the MCP JSON-RPC channel. Never print to stdout.
 * All logging goes to stderr via log().
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync } from "fs";
import { basename, extname } from "path";

const PORT = 8787;
const TOKEN = "vc-debug-bridge-2f9a4c1e";
const BASE = `http://127.0.0.1:${PORT}`;
const DAEMON_PATH = new URL("./daemon.ts", import.meta.url).pathname;

const log = (...a: unknown[]) => console.error("[discord-bridge-mcp]", ...a);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Hard cap on a single tool result — stops a runaway eval from nuking the context window. */
const MAX_RESULT_CHARS = 80_000;
const cap = (s: string) =>
    s.length <= MAX_RESULT_CHARS ? s
        : s.slice(0, MAX_RESULT_CHARS) +
          `\n…[truncated ${s.length - MAX_RESULT_CHARS} chars — narrow your \`return\` or lower \`depth\`]`;

interface BridgeReply { id?: string; ok: boolean; result?: unknown; error?: string; }

/* ----------------------------------------------------------- daemon glue -- */

const withToken = (path: string) => `${BASE}${path}${path.includes("?") ? "&" : "?"}token=${TOKEN}`;

async function daemonHealthy(): Promise<boolean> {
    try {
        const r = await fetch(withToken("/health"), { signal: AbortSignal.timeout(1500) });
        return r.ok;
    } catch { return false; }
}

let ensuring: Promise<void> | null = null;

/** Make sure the daemon is up; spawn it detached if not. Coalesced. */
function ensureDaemon(): Promise<void> {
    if (ensuring) return ensuring;
    ensuring = (async () => {
        if (await daemonHealthy()) return;
        log("daemon not running — spawning it detached");
        try {
            // `setsid` puts the daemon in its own session so it survives this
            // MCP server (and Claude Code) being killed. A second spawn loses
            // the port race and exits — the daemon stays a singleton.
            Bun.spawn(["setsid", process.execPath, DAEMON_PATH], {
                stdin: "ignore", stdout: "ignore", stderr: "ignore",
            }).unref();
        } catch (e) {
            log("failed to spawn daemon: " + errMsg(e));
        }
        for (let i = 0; i < 50; i++) {           // wait up to ~10s for it to bind
            if (await daemonHealthy()) { log("daemon is up"); return; }
            await sleep(200);
        }
        log("daemon did not come up within 10s");
    })().finally(() => { ensuring = null; });
    return ensuring;
}

/** Fetch the daemon, (re)spawning it and retrying once on a connection error. */
async function daemonFetch(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    try {
        return await fetch(withToken(path), { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
        await ensureDaemon();
        return await fetch(withToken(path), { ...init, signal: AbortSignal.timeout(timeoutMs) });
    }
}

async function daemonEval(code: string, depth?: number, timeoutMs = 20_000): Promise<BridgeReply> {
    const qs = new URLSearchParams();
    if (depth) qs.set("depth", String(depth));
    qs.set("timeoutMs", String(timeoutMs));
    const path = `/eval?${qs.toString()}`;
    // HTTP timeout slightly longer than the eval budget so the daemon's own
    // timer fires first and we get a clean "bridge call timed out" error
    // instead of an AbortError from fetch.
    const res = await daemonFetch(path, { method: "POST", body: code }, timeoutMs + 5_000);
    return (await res.json()) as BridgeReply;
}

/* ------------------------------------------------------------- mcp glue -- */

type ContentBlock =
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: ContentBlock[]; isError?: boolean };

function text(s: string, isError = false): ToolResult {
    return { content: [{ type: "text", text: s }], isError: isError || undefined };
}

function formatReply(reply: BridgeReply): ToolResult {
    if (reply.ok) {
        const r = reply.result;
        return text(cap(typeof r === "string" ? r : (JSON.stringify(r, null, 2) ?? "undefined")));
    }
    return text("Discord renderer error:\n" + (reply.error ?? "unknown error"), true);
}

async function runInRenderer(code: string, depth?: number, timeoutMs?: number): Promise<ToolResult> {
    try {
        return formatReply(await daemonEval(code, depth, timeoutMs));
    } catch (e) {
        return text("Bridge error: " + errMsg(e), true);
    }
}

const mcp = new McpServer({ name: "discord-bridge", version: "2.9.0" });

mcp.registerTool("discord_eval", {
    description:
        "Evaluate JavaScript in the running Discord (Vencord) renderer and return the result. " +
        "Global scope: `Vencord`, `document`, `window`; `await` works. Pass one expression, or " +
        "statements with an explicit `return`. Results are cycle-safe, serialized to `depth` " +
        "levels (default 3); DOM nodes return as { tag, classes, outerHTML }. Token tip: " +
        "`return` only the fields you need.",
    inputSchema: {
        code: z.string().optional().describe("JavaScript to evaluate. Provide this or `file`."),
        file: z.string().optional().describe("Absolute path to a .js file to evaluate instead of `code`."),
        depth: z.number().int().min(1).max(20).optional().describe("Result serialization depth (default 3; raise only for nested data)."),
    },
}, async ({ code, file, depth }) => {
    let src = code;
    if (file) {
        try { src = readFileSync(file, "utf8"); }
        catch (e) { return text("Could not read file: " + errMsg(e), true); }
    }
    if (!src || !src.trim()) return text("Provide `code` or `file`.", true);
    return runInRenderer(src, depth ?? 3);
});

mcp.registerTool("discord_query", {
    description:
        "querySelectorAll a CSS selector in the Discord renderer — returns matched elements " +
        "as { tag, id, classes, text, outerHTML }. Use it to discover Discord's minified CSS " +
        "class names for a UI element.",
    inputSchema: {
        selector: z.string().describe(`CSS selector, e.g. [class*="chatContent"].`),
        limit: z.number().int().min(1).max(50).optional().describe("Max elements to return (default 6)."),
    },
}, async ({ selector, limit }) => runInRenderer(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    return {
        count: els.length,
        elements: els.slice(0, ${limit ?? 6}).map(el => ({
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            classes: [...el.classList],
            text: (el.textContent || "").trim().slice(0, 100),
            outerHTML: el.outerHTML.slice(0, 160),
        })),
    };
})()`));

mcp.registerTool("discord_findModule", {
    description:
        "Search Discord's webpack modules. Provide `code` (substrings that must ALL appear " +
        "in a module's factory source) to locate modules and get an id + source snippet — " +
        "use this to write Vencord patch find/replacement regexes. And/or provide `props` " +
        "(property names a module must ALL export) to find a module and see its keys and " +
        "string values — use this to find Discord's CSS class-name maps.",
    inputSchema: {
        code: z.array(z.string()).optional().describe("Substrings that must ALL appear in a module's source."),
        props: z.array(z.string()).optional().describe("Property names a single module must ALL export."),
    },
}, async ({ code, props }) => {
    if ((!code || code.length === 0) && (!props || props.length === 0))
        return text("Provide `code` and/or `props`.", true);
    return runInRenderer(`(() => {
        const W = Vencord.Webpack;
        const wreq = W.wreq || W.webpackRequire || null;
        const CODE = ${JSON.stringify(code ?? null)};
        const PROPS = ${JSON.stringify(props ?? null)};
        const out = {};
        if (PROPS) {
            let m = null;
            try { m = W.findByProps(...PROPS); } catch (e) {}
            out.props = m ? {
                keys: Object.keys(m).slice(0, 60),
                values: Object.fromEntries(Object.entries(m).slice(0, 60)
                    .map(([k, v]) => [k, typeof v === "string" ? v : typeof v])),
            } : "no module found exporting all of: " + PROPS.join(", ");
        }
        if (CODE) {
            if (!wreq || !wreq.m) {
                out.code = "webpack module map (wreq.m) is unavailable";
            } else {
                const hits = [];
                for (const id in wreq.m) {
                    let src = "";
                    try { src = Function.prototype.toString.call(wreq.m[id]); } catch (e) { continue; }
                    if (CODE.every(c => src.includes(c))) {
                        const idx = src.indexOf(CODE[0]);
                        hits.push({
                            id,
                            sourceLength: src.length,
                            snippet: src.slice(Math.max(0, idx - 120), idx + 320),
                        });
                        if (hits.length >= 5) break;
                    }
                }
                out.code = { matches: hits.length, hits };
            }
        }
        return out;
    })()`);
});

mcp.registerTool("discord_click", {
    description:
        "Click an element (button, menu item, etc.) in the Discord renderer — dispatches a " +
        "synthetic pointer/mouse/click sequence on the selector match. Note: events are " +
        "isTrusted=false, so Discord ignores them on guarded actions like sending a message.",
    inputSchema: {
        selector: z.string().describe(`CSS selector of the element to click, e.g. button[aria-label="Edit"].`),
        index: z.number().int().min(0).optional().describe("Which match to click when several (default 0)."),
    },
}, async ({ selector, index }) => runInRenderer(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    if (!els.length) return { ok: false, error: "selector matched nothing: " + ${JSON.stringify(selector)} };
    const el = els[${index ?? 0}];
    if (!el) return { ok: false, error: "index ${index ?? 0} is out of range (" + els.length + " matches)" };
    try { el.scrollIntoView({ block: "center" }); } catch (e) {}
    const r = el.getBoundingClientRect();
    const pt = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, view: window };
    for (const t of ["pointerover", "pointerdown", "mousedown", "mouseup", "pointerup", "click"]) {
        const C = t.startsWith("pointer") ? (window.PointerEvent || MouseEvent) : MouseEvent;
        try { el.dispatchEvent(new C(t, pt)); } catch (e) {}
    }
    return {
        ok: true, matches: els.length, clickedIndex: ${index ?? 0},
        element: {
            tag: el.tagName.toLowerCase(),
            classes: [...el.classList],
            ariaLabel: el.getAttribute("aria-label") || undefined,
            text: (el.textContent || "").trim().slice(0, 80),
        },
    };
})()`));

mcp.registerTool("discord_key", {
    description:
        "Dispatch a keyboard event/shortcut in the Discord renderer — e.g. \"Ctrl+K\", " +
        "\"Escape\", \"ArrowDown\". Fires keydown/keypress/keyup on the target (a CSS " +
        "selector, or the focused element). Note: events are isTrusted=false, so Discord " +
        "ignores them on guarded actions like Enter-to-send.",
    inputSchema: {
        combo: z.string().describe(`Key or combo, e.g. "Ctrl+K", "Escape", "ArrowDown", "Shift+Tab".`),
        selector: z.string().optional().describe("CSS selector of the target element (default: the focused element)."),
    },
}, async ({ combo, selector }) => runInRenderer(`(() => {
    const COMBO = ${JSON.stringify(combo)};
    const SELECTOR = ${JSON.stringify(selector ?? null)};
    const parts = COMBO.split("+").map(s => s.trim()).filter(Boolean);
    const keyName = parts.pop() || "";
    const mods = parts.map(p => p.toLowerCase());
    const flags = {
        ctrlKey: mods.includes("ctrl") || mods.includes("control"),
        shiftKey: mods.includes("shift"),
        altKey: mods.includes("alt"),
        metaKey: mods.includes("meta") || mods.includes("cmd") || mods.includes("super"),
    };
    const named = {
        enter: ["Enter", "Enter", 13], escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
        tab: ["Tab", "Tab", 9], backspace: ["Backspace", "Backspace", 8], "delete": ["Delete", "Delete", 46],
        space: [" ", "Space", 32], spacebar: [" ", "Space", 32],
        up: ["ArrowUp", "ArrowUp", 38], down: ["ArrowDown", "ArrowDown", 40],
        left: ["ArrowLeft", "ArrowLeft", 37], right: ["ArrowRight", "ArrowRight", 39],
        arrowup: ["ArrowUp", "ArrowUp", 38], arrowdown: ["ArrowDown", "ArrowDown", 40],
        arrowleft: ["ArrowLeft", "ArrowLeft", 37], arrowright: ["ArrowRight", "ArrowRight", 39],
        home: ["Home", "Home", 36], end: ["End", "End", 35],
        pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34],
    };
    let key, code, keyCode;
    const low = keyName.toLowerCase();
    if (named[low]) { [key, code, keyCode] = named[low]; }
    else if (keyName.length === 1) {
        const u = keyName.toUpperCase();
        key = flags.shiftKey ? u : keyName.toLowerCase();
        if (u >= "A" && u <= "Z") { code = "Key" + u; keyCode = u.charCodeAt(0); }
        else if (u >= "0" && u <= "9") { code = "Digit" + u; keyCode = u.charCodeAt(0); }
        else { code = ""; keyCode = keyName.charCodeAt(0); }
    } else { key = keyName; code = keyName; keyCode = 0; }
    const target = SELECTOR ? document.querySelector(SELECTOR) : (document.activeElement || document.body);
    if (SELECTOR && !target) return { ok: false, error: "selector matched nothing: " + SELECTOR };
    try { if (target.focus) target.focus(); } catch (e) {}
    const mk = type => new KeyboardEvent(type, { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, ...flags });
    const notCancelled = target.dispatchEvent(mk("keydown"));
    if (keyName.length === 1 && !flags.ctrlKey && !flags.metaKey) target.dispatchEvent(mk("keypress"));
    target.dispatchEvent(mk("keyup"));
    return {
        ok: true,
        dispatched: { key, code, keyCode, ctrl: flags.ctrlKey, shift: flags.shiftKey, alt: flags.altKey, meta: flags.metaKey },
        target: target.tagName ? target.tagName.toLowerCase() : String(target),
        keydownNotCancelled: notCancelled,
    };
})()`));

mcp.registerTool("discord_console", {
    description:
        "Return recent console warnings/errors and uncaught exceptions from the Discord " +
        "renderer (oldest first). Check after an eval or a plugin/Vencord change.",
    inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("Max entries to return (default 20)."),
    },
}, async ({ limit }) => runInRenderer(
    `((globalThis.$discordBridge && globalThis.$discordBridge.console) || []).slice(-${limit ?? 20})`));

mcp.registerTool("discord_screenshot", {
    description:
        "Screenshot the running Discord (Vencord) renderer as an image — to SEE the UI " +
        "(verify a layout/styling change, debug a visual bug). Pass `selector` to capture one " +
        "element (cheaper — fewer tokens — and scrolled into view first); omit for the whole " +
        "viewport. Only the visible viewport is captured; scroll or navigate first if needed. " +
        "Pass `savePath` to write the bytes to disk instead of inlining the image — the " +
        "returned path feeds straight into `discord_send({files: [path]})`.",
    inputSchema: {
        selector: z.string().optional().describe("CSS selector of one element to capture; omit for the full window."),
        format: z.enum(["png", "jpeg"]).optional().describe("Image format (default jpeg — smaller; png is lossless)."),
        maxWidth: z.number().int().min(64).max(4096).optional().describe("Scale down so width ≤ this many px (default 1280)."),
        quality: z.number().int().min(1).max(100).optional().describe("JPEG quality 1–100 (default 70; ignored for png)."),
        savePath: z.string().optional().describe("Absolute path to write the image bytes to. When set, the image is NOT inlined in the reply — only the path + dimensions text comes back."),
    },
}, async ({ selector, format, maxWidth, quality, savePath }) => {
    try {
        const res = await daemonFetch("/screenshot", {
            method: "POST",
            body: JSON.stringify({
                selector,
                format: format ?? "jpeg",
                maxWidth: maxWidth ?? 1280,
                quality: quality ?? 70,
            }),
        }, 35_000);
        const reply = (await res.json()) as BridgeReply;
        if (!reply.ok)
            return text("Screenshot failed:\n" + (reply.error ?? "unknown error"), true);
        const r = reply.result as { data: string; mimeType: string; width: number; height: number; bytes: number };
        const summary = `${r.width}×${r.height}px ${r.mimeType} (${Math.round(r.bytes / 1024)} KB)` +
            (selector ? ` of \`${selector}\`` : "");
        if (savePath) {
            try { writeFileSync(savePath, Buffer.from(r.data, "base64")); }
            catch (e) { return text(`Captured ${summary} but failed to write to ${savePath}: ${errMsg(e)}`, true); }
            return text(`Saved ${summary} → ${savePath}`);
        }
        return {
            content: [
                { type: "image", data: r.data, mimeType: r.mimeType },
                { type: "text", text: `Captured ${summary}.` },
            ],
        };
    } catch (e) {
        return text("Screenshot error: " + errMsg(e), true);
    }
});

/** Cheap extension → mime map. Discord re-sniffs many types, so unknowns fall back to octet-stream. */
const MIME_BY_EXT: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
    ".pdf": "application/pdf", ".zip": "application/zip", ".json": "application/json",
    ".txt": "text/plain", ".md": "text/markdown", ".html": "text/html", ".css": "text/css",
    ".js": "text/javascript", ".ts": "text/typescript",
};
const guessMime = (path: string) => MIME_BY_EXT[extname(path).toLowerCase()] || "application/octet-stream";

mcp.registerTool("discord_open", {
    description:
        "Switch Discord to a specific channel (DM, group DM, or guild channel) — same code " +
        "path the sidebar uses (`ChannelActions.selectChannel`). Optionally scroll-jump to a " +
        "message via `messageId`. Result confirms whether `SelectedChannelStore` actually " +
        "flipped, and includes resolved channel + recipients. Typical flow: " +
        "`discord_dms({query})` → `discord_open({channelId})` → `discord_view()`.",
    inputSchema: {
        channelId: z.string().describe("Channel ID to switch to (from `discord_dms`, `discord_view`, or elsewhere)."),
        messageId: z.string().optional().describe("Optional message ID to scroll-jump to within the channel."),
    },
}, async ({ channelId, messageId }) => {
    const argJson = JSON.stringify({ channelId, messageId });
    const code =
        `(globalThis.$discordBridge && globalThis.$discordBridge.openChannel)` +
        `  ? globalThis.$discordBridge.openChannel(${argJson})` +
        `  : (() => { throw new Error("DebugBridge openChannel helper missing — plugin out of date; rebuild & redeploy.") })()`;
    return runInRenderer(code, 4);
});

mcp.registerTool("discord_dms", {
    description:
        "List Discord direct messages and group DMs in sidebar order — lets you resolve a " +
        "person's name to a channelId for `discord_send`. Pass `query` (case-insensitive " +
        "substring) to filter; results are ranked exact > prefix > substring across the DM " +
        "display name, recipient display names, and recipient usernames. Each entry returns " +
        "`{channelId, kind: \"dm\"|\"group\", name, memberCount?, recipients: [{id, username, name, bot}]}`. " +
        "Typical flow: `discord_dms({query:\"kavi\"})` → grab channelId → `discord_send({channelId, content})`.",
    inputSchema: {
        query: z.string().optional().describe("Case-insensitive name filter (substring). Omit to list everything in sidebar order."),
        limit: z.number().int().min(1).max(100).optional().describe("Cap on results (default: 10 when query, 50 otherwise)."),
    },
}, async ({ query, limit }) => {
    const argJson = JSON.stringify({ query, limit });
    const code =
        `(globalThis.$discordBridge && globalThis.$discordBridge.listDMs)` +
        `  ? globalThis.$discordBridge.listDMs(${argJson})` +
        `  : (() => { throw new Error("DebugBridge listDMs helper missing — plugin out of date; rebuild & redeploy.") })()`;
    return runInRenderer(code, 6);
});

mcp.registerTool("discord_view", {
    description:
        "Read what the user is currently looking at in Discord — the selected channel and " +
        "the messages rendered in the viewport. Works with scroll: Discord virtualizes " +
        "off-screen messages out of the DOM, so if the user scrolls up to look at history, " +
        "*that* slice is what comes back. Each message includes author info (id, username, " +
        "display name, bot flag), content, timestamp, attachments, reply ref, and mentions. " +
        "Each message's top-level `id` is the value to pass as `replyToMessageId` to " +
        "`discord_send` when replying to that specific message. " +
        "`scroll.atBottom` tells you if the user is following live or browsing history. " +
        "Use this as the default \"what's happening here?\" lookup.",
    inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("Cap on messages returned (default 100; capped at what's actually rendered)."),
        includeEmbeds: z.boolean().optional().describe("Include embed details (title/desc/url). Default false — only an `embedCount`."),
        includeReactions: z.boolean().optional().describe("Include reaction details (emoji/count/me). Default false — only a `reactionCount`."),
        resolveReplies: z.number().int().min(0).max(20).optional().describe("For each message with `replyTo`, walk up to N parents and embed them inline as `replyChain` (oldest→newest). REST-fetches parents that aren't in the local store, so this also resolves the `{unloaded: true}` case. Default 0 (no expansion). 2–3 is plenty for normal threads."),
    },
}, async ({ limit, includeEmbeds, includeReactions, resolveReplies }) => {
    const argJson = JSON.stringify({ limit, includeEmbeds, includeReactions, resolveReplies });
    const code =
        `(globalThis.$discordBridge && globalThis.$discordBridge.getView)` +
        `  ? globalThis.$discordBridge.getView(${argJson})` +
        `  : (() => { throw new Error("DebugBridge getView helper missing — plugin out of date; rebuild & redeploy.") })()`;
    return runInRenderer(code, 6);
});

mcp.registerTool("discord_send", {
    description:
        "Send a message in Discord natively — uses `MessageActions.sendMessage` (or " +
        "`UploadManager.uploadFiles` when attachments are included), the same code path " +
        "Discord's own composer uses. Unlike `discord_click` + `discord_key`, this is NOT " +
        "blocked by isTrusted=false. `channelId` defaults to the currently selected channel. " +
        "When this message is a direct response to a specific prior message (answering a " +
        "question, quoting back, follow-up that names what it's reacting to), set " +
        "`replyToMessageId` so it renders as a native Discord reply — don't rely on temporal " +
        "proximity alone. Result includes the resolved channel {id, name, guildName} so you " +
        "can verify where it landed.",
    inputSchema: {
        content: z.string().optional().describe("Message text. Required unless `files` is given. Discord parses mentions / markdown as usual."),
        channelId: z.string().optional().describe("Target channel ID. Omit to use the currently selected channel."),
        replyToMessageId: z.string().optional().describe("Message ID to reply to — adds a native Discord reply reference. Prefer this whenever the message is a direct response to a specific prior message (answer, quote-back, named follow-up). Pull the ID from a fresh `discord_view` result; never fabricate — unknown IDs are pre-validated against the local message store and rejected with an error."),
        files: z.array(z.string()).optional().describe("Absolute paths of files to attach. Mime is guessed from extension."),
        tts: z.boolean().optional().describe("Send as text-to-speech (default false)."),
        typing: z.boolean().optional().describe("Show the typing indicator before sending; duration auto-derived from content length (~60ms/char, clamped 800ms–6000ms). Ignored if `typingMs` is set."),
        typingMs: z.number().int().min(0).max(30_000).optional().describe("Explicit typing duration in ms (overrides `typing`). Capped at 30s."),
    },
}, async ({ content, channelId, replyToMessageId, files, tts, typing, typingMs }) => {
    if ((!content || !content.trim()) && (!files || files.length === 0))
        return text("Provide `content` and/or `files`.", true);

    const fileArgs: { name: string; mime: string; base64: string; }[] = [];
    if (files?.length) {
        for (const p of files) {
            try {
                const buf = readFileSync(p);
                fileArgs.push({ name: basename(p), mime: guessMime(p), base64: buf.toString("base64") });
            } catch (e) {
                return text(`Failed to read file ${p}: ${errMsg(e)}`, true);
            }
        }
    }

    const argJson = JSON.stringify({ channelId, content, replyToMessageId, files: fileArgs, tts, typing, typingMs });
    const code =
        `(globalThis.$discordBridge && globalThis.$discordBridge.sendMessage)` +
        `  ? globalThis.$discordBridge.sendMessage(${argJson})` +
        `  : (() => { throw new Error("DebugBridge sendMessage helper missing — plugin out of date; rebuild & redeploy.") })()`;
    // Pad timeout to cover the typing-pretend pause + actual send/upload.
    const typingPad = (typing || typingMs) ? (typingMs ?? 6_000) + 2_000 : 0;
    const timeoutMs = (fileArgs.length ? 60_000 : 20_000) + typingPad;
    try {
        return formatReply(await daemonEval(code, 3, timeoutMs));
    } catch (e) {
        return text("Bridge error: " + errMsg(e), true);
    }
});

mcp.registerTool("discord_history", {
    description:
        "Fetch a paginated slice of channel history via Discord REST — the primitive for " +
        "\"give me the last N messages\" or \"every message between X and Y\". Unlike " +
        "`discord_view` (which is bounded to the user's current viewport), this walks the " +
        "real backlog and works for any channelId. Pages internally in 100-message chunks " +
        "and returns oldest-first so the result reads like a transcript. " +
        "Bound the window with `before`/`after` snowflakes, or `since`/`until` ISO " +
        "timestamps (auto-converted to snowflakes). `from`/`contains` are client-side " +
        "filters applied after the fetch. Always pass a tight `select` projection — the " +
        "default ([id, content, author, timestamp]) is what you usually want; only widen it " +
        "when you actually need attachments / replyTo / mentions / reactions. " +
        "If `hasMoreBefore` is true, pass `nextBefore` back as `before` to keep paging deeper.",
    inputSchema: {
        channelId: z.string().optional().describe("Target channel ID. Omit to use the currently selected channel."),
        before: z.string().optional().describe("Snowflake — return messages strictly older than this ID."),
        after: z.string().optional().describe("Snowflake — return messages strictly newer than this ID."),
        around: z.string().optional().describe("Snowflake — return messages around this ID (single 100-msg window; ignores `limit`)."),
        since: z.string().optional().describe("ISO timestamp lower bound (auto-converted to a snowflake). Ignored if `after` is set."),
        until: z.string().optional().describe("ISO timestamp upper bound (auto-converted to a snowflake). Ignored if `before` is set."),
        from: z.string().optional().describe("Filter to messages from this user ID (client-side; Discord REST has no author filter)."),
        contains: z.string().optional().describe("Filter to messages whose content includes this substring, case-insensitive."),
        limit: z.number().int().min(1).max(5000).optional().describe("Max messages to return (default 200, max 5000). Pages internally; raise only when you really need it."),
        select: z.array(z.enum(["id", "content", "author", "timestamp", "attachments", "replyTo", "mentions", "reactions", "edited"])).optional().describe("Field projection. Default: [id, content, author, timestamp]. `id` is always included. Keep this tight — token usage scales linearly."),
        resolveReplies: z.number().int().min(0).max(20).optional().describe("Walk each reply's parent chain up to N hops and embed as `replyChain` (oldest→newest). Auto-adds `replyTo` to the projection. Default 0 (no expansion)."),
    },
}, async (args) => {
    const code =
        `(globalThis.$discordBridge && globalThis.$discordBridge.getHistory)` +
        `  ? globalThis.$discordBridge.getHistory(${JSON.stringify(args)})` +
        `  : (() => { throw new Error("DebugBridge getHistory helper missing — plugin out of date; rebuild & redeploy.") })()`;
    return runInRenderer(code, 6, 120_000);
});

mcp.registerTool("discord_search", {
    description:
        "Search messages via Discord's native `/messages/search` endpoint — the right tool " +
        "for \"find every message about X\" or \"what did Alice say about Y\". Works on DMs, " +
        "group DMs, and guild channels (uses the guild-level search URL automatically when " +
        "applicable). Loops `offset` pagination internally up to `limit`. " +
        "Returns `{ totalResults, count, messages }` — each result has `hit: true` and the " +
        "standard projected fields. If Discord is still indexing the channel, the result is " +
        "`{ indexing: true, retryAfter }` — wait that many seconds and try again. " +
        "Prefer this over `discord_history` + client-side `contains` when you have a real " +
        "keyword query (search hits are server-side ranked and span much further back).",
    inputSchema: {
        query: z.string().describe("Search query — words/phrases. Same syntax Discord's search bar uses."),
        channelId: z.string().optional().describe("Target channel ID. Omit to use the currently selected channel."),
        from: z.string().optional().describe("Restrict to messages by this user ID (`author_id`)."),
        mentions: z.string().optional().describe("Restrict to messages mentioning this user ID."),
        has: z.array(z.enum(["image", "video", "link", "file", "embed", "sound", "sticker"])).optional().describe("Restrict to messages containing these attachment kinds (Discord's `has=` filter)."),
        before: z.string().optional().describe("Snowflake max bound (`max_id`)."),
        after: z.string().optional().describe("Snowflake min bound (`min_id`)."),
        limit: z.number().int().min(1).max(200).optional().describe("Max results to return (default 25, max 200; Discord pages 25 at a time)."),
    },
}, async (args) => {
    const code =
        `(globalThis.$discordBridge && globalThis.$discordBridge.searchMessages)` +
        `  ? globalThis.$discordBridge.searchMessages(${JSON.stringify(args)})` +
        `  : (() => { throw new Error("DebugBridge searchMessages helper missing — plugin out of date; rebuild & redeploy.") })()`;
    return runInRenderer(code, 6, 60_000);
});

mcp.registerTool("discord_stats", {
    description:
        "Compute aggregate stats over a channel + time window — the right tool for \"who " +
        "posts most\", \"how active was this DM each month\", \"what links/words come up\". " +
        "Walks the channel via REST in 100-msg batches (bounded by `hardCap`, default 50k) " +
        "and emits a fixed-size summary regardless of how many messages were scanned. " +
        "Output includes: `summary` (total/attachments/links/replies/distinctAuthors/span), " +
        "`byAuthor` ranked top-N, `byBucket` time series, `replyEdges` top reply graph, " +
        "`topDomains` from links, `topWords` (PT + EN stopwords stripped). " +
        "Stopword list is built-in — don't ask for filtering. Use `since`/`until` to bound " +
        "the window; without them, the entire channel is scanned up to `hardCap`.",
    inputSchema: {
        channelId: z.string().optional().describe("Target channel ID. Omit to use the currently selected channel."),
        since: z.string().optional().describe("ISO timestamp lower bound. Omit to scan back to channel start (capped by `hardCap`)."),
        until: z.string().optional().describe("ISO timestamp upper bound. Omit to scan from the latest message."),
        groupBy: z.enum(["day", "week", "month"]).optional().describe("Time bucket granularity for `byBucket` (default `month`)."),
        topN: z.number().int().min(1).max(100).optional().describe("Cap on each ranked list (byAuthor / replyEdges / topDomains / topWords). Default 10."),
        hardCap: z.number().int().min(100).max(200_000).optional().describe("Max messages to scan (default 50000). Tighten for fast channels; raise only for full-channel runs."),
    },
}, async (args) => {
    const code =
        `(globalThis.$discordBridge && globalThis.$discordBridge.getStats)` +
        `  ? globalThis.$discordBridge.getStats(${JSON.stringify(args)})` +
        `  : (() => { throw new Error("DebugBridge getStats helper missing — plugin out of date; rebuild & redeploy.") })()`;
    return runInRenderer(code, 6, 180_000);
});

mcp.registerTool("discord_react", {
    description:
        "Add or remove a reaction on a message — uses Discord's internal " +
        "`addReaction`/`removeReaction`, the same path the reaction picker uses. " +
        "Accepts either raw unicode (`\"👍\"`, `\"🔥\"`) or full custom-emoji syntax " +
        "(`\"<:pepega:1234>\"`, `\"<a:dance:5678>\"`). Shortcodes (`:thumbsup:`) are NOT " +
        "resolved — paste the unicode character or the `<:name:id>` form. " +
        "`messageId` is pre-validated against the local MessageStore: a fabricated ID " +
        "errors instead of silently no-op-ing.",
    inputSchema: {
        messageId: z.string().describe("Message to react to. Pull from a fresh `discord_view`/`discord_history` result."),
        emoji: z.string().describe("Emoji — raw unicode (`👍`) or `<:name:id>` / `<a:name:id>` for custom."),
        channelId: z.string().optional().describe("Target channel ID. Omit to use the currently selected channel."),
        action: z.enum(["add", "remove"]).optional().describe("Default `add`. Use `remove` to take your own reaction back off."),
    },
}, async (args) => {
    const code =
        `(globalThis.$discordBridge && globalThis.$discordBridge.react)` +
        `  ? globalThis.$discordBridge.react(${JSON.stringify(args)})` +
        `  : (() => { throw new Error("DebugBridge react helper missing — plugin out of date; rebuild & redeploy.") })()`;
    return runInRenderer(code, 3);
});

mcp.registerTool("discord_edit", {
    description:
        "Edit one of the viewer's own messages — `MessageActions.editMessage`. " +
        "Discord only allows editing your own messages, so the tool refuses on " +
        "anyone else's. `messageId` is pre-validated against MessageStore. " +
        "Use only on explicit user instruction — editing is visible to recipients " +
        "as an `(edited)` marker.",
    inputSchema: {
        messageId: z.string().describe("Message to edit — must be one you sent. Pull from `discord_view`/`discord_history`."),
        content: z.string().describe("New full message content (replaces the previous text — this is not a patch)."),
        channelId: z.string().optional().describe("Target channel ID. Omit to use the currently selected channel."),
    },
}, async (args) => {
    const code =
        `(globalThis.$discordBridge && globalThis.$discordBridge.editMessage)` +
        `  ? globalThis.$discordBridge.editMessage(${JSON.stringify(args)})` +
        `  : (() => { throw new Error("DebugBridge editMessage helper missing — plugin out of date; rebuild & redeploy.") })()`;
    return runInRenderer(code, 3);
});

mcp.registerTool("discord_delete", {
    description:
        "Delete one of the viewer's own messages — `MessageActions.deleteMessage`. " +
        "DESTRUCTIVE: the message is gone, recipients lose access immediately, no " +
        "Discord-side undo. Only invoke on explicit user instruction (\"delete my " +
        "last message\", \"remove that reply\"); never on inference. The tool " +
        "refuses on messages the viewer did not send and pre-validates the " +
        "messageId against MessageStore.",
    inputSchema: {
        messageId: z.string().describe("Message to delete — must be one you sent. Pull from `discord_view`/`discord_history`."),
        channelId: z.string().optional().describe("Target channel ID. Omit to use the currently selected channel."),
    },
}, async (args) => {
    const code =
        `(globalThis.$discordBridge && globalThis.$discordBridge.deleteMessage)` +
        `  ? globalThis.$discordBridge.deleteMessage(${JSON.stringify(args)})` +
        `  : (() => { throw new Error("DebugBridge deleteMessage helper missing — plugin out of date; rebuild & redeploy.") })()`;
    return runInRenderer(code, 3);
});

mcp.registerTool("discord_pins", {
    description:
        "List a channel's pinned messages via Discord REST — pins are usually " +
        "the channel's thesis (rules, decisions, links), so this is cheap, " +
        "high-signal context for orienting in an unfamiliar channel. Each entry " +
        "uses the same projection shape as `discord_history`.",
    inputSchema: {
        channelId: z.string().optional().describe("Target channel ID. Omit to use the currently selected channel."),
        select: z.array(z.enum(["id", "content", "author", "timestamp", "attachments", "replyTo", "mentions", "reactions", "edited"])).optional().describe("Field projection. Default: [id, content, author, timestamp]."),
    },
}, async (args) => {
    const code =
        `(globalThis.$discordBridge && globalThis.$discordBridge.getPins)` +
        `  ? globalThis.$discordBridge.getPins(${JSON.stringify(args)})` +
        `  : (() => { throw new Error("DebugBridge getPins helper missing — plugin out of date; rebuild & redeploy.") })()`;
    return runInRenderer(code, 6, 30_000);
});

mcp.registerTool("discord_threads", {
    description:
        "List threads under a parent channel — both active and (optionally) " +
        "recently archived public threads. Threads are first-class channels in " +
        "Discord; their IDs are usable as a `channelId` for `discord_view`, " +
        "`discord_history`, `discord_send`, etc. If you pass a thread's own ID " +
        "as `channelId`, the tool treats its parent as the listing target.",
    inputSchema: {
        channelId: z.string().optional().describe("Parent channel ID. Omit to use the currently selected channel."),
        includeArchived: z.boolean().optional().describe("Include recently archived public threads (default true)."),
        archivedLimit: z.number().int().min(1).max(100).optional().describe("How many archived threads to fetch (default 25)."),
    },
}, async (args) => {
    const code =
        `(globalThis.$discordBridge && globalThis.$discordBridge.getThreads)` +
        `  ? globalThis.$discordBridge.getThreads(${JSON.stringify(args)})` +
        `  : (() => { throw new Error("DebugBridge getThreads helper missing — plugin out of date; rebuild & redeploy.") })()`;
    return runInRenderer(code, 6, 30_000);
});

mcp.registerTool("discord_member", {
    description:
        "Look up a user's full profile — display name, avatar, bio/pronouns, " +
        "mutual guilds (via `/users/{id}/profile`), plus live status and " +
        "activities (`PresenceStore`). Useful for disambiguating (\"which " +
        "Igor?\"), tone calibration (don't ping at 3am), or addressing someone " +
        "by their `globalName` instead of their `username`. Some users return " +
        "limited data when you share no context — username/avatar fall back to " +
        "the local UserStore if the profile API rejects.",
    inputSchema: {
        userId: z.string().describe("Discord user ID (snowflake). Pull from `discord_view` / `discord_dms` / message author fields."),
    },
}, async (args) => {
    const code =
        `(globalThis.$discordBridge && globalThis.$discordBridge.getMember)` +
        `  ? globalThis.$discordBridge.getMember(${JSON.stringify(args)})` +
        `  : (() => { throw new Error("DebugBridge getMember helper missing — plugin out of date; rebuild & redeploy.") })()`;
    return runInRenderer(code, 4, 20_000);
});

mcp.registerTool("discord_resolveMessage", {
    description:
        "Fetch one message + its reply ancestry. REST-fetches anything not in " +
        "the local MessageStore, so this works even when the parent was " +
        "scrolled out or is from a different channel. Returns `{ message, " +
        "replyChain }` — `replyChain` is the parent thread oldest→newest, " +
        "capped at `depth`. Use when a `discord_view` reply came back as " +
        "`{unloaded: true}`, or when you want the full conversational arc " +
        "behind a single message without re-fetching the whole channel.",
    inputSchema: {
        messageId: z.string().describe("Message ID to resolve."),
        channelId: z.string().optional().describe("Channel the message lives in. Omit to use the currently selected channel."),
        depth: z.number().int().min(0).max(20).optional().describe("Max parent hops to walk (default 5). 0 returns just the message."),
    },
}, async (args) => {
    const code =
        `(globalThis.$discordBridge && globalThis.$discordBridge.resolveMessage)` +
        `  ? globalThis.$discordBridge.resolveMessage(${JSON.stringify(args)})` +
        `  : (() => { throw new Error("DebugBridge resolveMessage helper missing — plugin out of date; rebuild & redeploy.") })()`;
    return runInRenderer(code, 6, 60_000);
});

mcp.registerTool("discord_attachment", {
    description:
        "Fetch the bytes of a message attachment so the model can actually see/read it — " +
        "for image attachments, the bytes come back as an inline image ContentBlock (so " +
        "the model perceives the image directly); for everything else, base64 in a text " +
        "block with mime + size. Default `index` is 0 (first attachment). Refuses files " +
        "larger than `maxBytes` (default 5 MB) — for those, get metadata via " +
        "`discord_view` / `discord_history` with the `attachments` projection instead. " +
        "Use this whenever a message references a screenshot, PDF, or other file the " +
        "user is asking about: without this tool you only see the filename.",
    inputSchema: {
        messageId: z.string().describe("Message that owns the attachment. Pull from `discord_view` / `discord_history`."),
        channelId: z.string().optional().describe("Target channel ID. Omit to use the currently selected channel."),
        index: z.number().int().min(0).optional().describe("Which attachment on the message (default 0)."),
        maxBytes: z.number().int().min(1).max(25_000_000).optional().describe("Refuse to return if the file is larger than this (default 5_000_000)."),
    },
}, async ({ messageId, channelId, index, maxBytes }) => {
    const cap = maxBytes ?? 5_000_000;
    const metaArg = JSON.stringify({ messageId, channelId, index });
    const code =
        `(globalThis.$discordBridge && globalThis.$discordBridge.attachment)` +
        `  ? globalThis.$discordBridge.attachment(${metaArg})` +
        `  : (() => { throw new Error("DebugBridge attachment helper missing — plugin out of date; rebuild & redeploy.") })()`;
    let meta: any;
    try {
        const reply = await daemonEval(code, 4, 20_000);
        if (!reply.ok) return text("Discord renderer error:\n" + (reply.error ?? "unknown error"), true);
        meta = reply.result;
    } catch (e) {
        return text("Bridge error: " + errMsg(e), true);
    }
    if (typeof meta?.size === "number" && meta.size > cap) {
        return text(
            `Attachment "${meta.name}" is ${meta.size} bytes (> maxBytes ${cap}). ` +
            `Skipping bytes; metadata only:\n${JSON.stringify(meta, null, 2)}`, true);
    }
    if (!meta?.url) return text("Attachment metadata missing URL:\n" + JSON.stringify(meta, null, 2), true);
    try {
        const r = await fetch(meta.url, { signal: AbortSignal.timeout(45_000) });
        if (!r.ok) return text(`CDN fetch failed (${r.status}) for ${meta.url}`, true);
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.byteLength > cap) {
            return text(
                `Attachment "${meta.name}" turned out to be ${buf.byteLength} bytes (> maxBytes ${cap}). ` +
                `Metadata only:\n${JSON.stringify(meta, null, 2)}`, true);
        }
        const mime = (meta.contentType as string | null) || r.headers.get("content-type") || "application/octet-stream";
        const base64 = Buffer.from(buf).toString("base64");
        const summary = `Fetched "${meta.name}" (${mime}, ${Math.round(buf.byteLength / 1024)} KB)` +
            (meta.width ? ` ${meta.width}×${meta.height}px` : "") + ".";
        if (mime.startsWith("image/")) {
            return {
                content: [
                    { type: "image", data: base64, mimeType: mime },
                    { type: "text", text: summary },
                ],
            };
        }
        return text(`${summary}\nbase64:\n${base64}`);
    } catch (e) {
        return text("Attachment fetch error: " + errMsg(e), true);
    }
});

mcp.registerTool("discord_dm_open", {
    description:
        "Open (or fetch) a 1:1 DM with a user, or a group DM with several users — REST " +
        "`POST /users/@me/channels`. Use when the target person isn't in the DM sidebar " +
        "yet, so `discord_dms` can't find them. Discord reuses the existing DM if one " +
        "already exists, so this is safe to call repeatedly. Result shape matches " +
        "`discord_dms` entries — pipe the `channelId` straight into `discord_send`.",
    inputSchema: {
        userId: z.string().optional().describe("Single recipient user ID. Use this for a 1:1 DM."),
        userIds: z.array(z.string()).min(1).optional().describe("Recipient user IDs for a group DM (2+ recommended)."),
    },
}, async (args) => {
    const code =
        `(globalThis.$discordBridge && globalThis.$discordBridge.dmOpen)` +
        `  ? globalThis.$discordBridge.dmOpen(${JSON.stringify(args)})` +
        `  : (() => { throw new Error("DebugBridge dmOpen helper missing — plugin out of date; rebuild & redeploy.") })()`;
    return runInRenderer(code, 4, 20_000);
});

mcp.registerTool("discord_emoji", {
    description:
        "List/search custom server emoji across all guilds the user is in. Returns each " +
        "as `{ name, id, animated, guildId, guildName, url, shortcode }` where " +
        "`shortcode` is the `<:name:id>` / `<a:name:id>` form ready to paste into " +
        "`discord_send` content or use directly with `discord_react`. Without this tool " +
        "the agent has no way to discover what custom emoji exist. Pass `query` for a " +
        "substring filter; ranked exact > prefix > substring. Output is projection + " +
        "limited (default 25) because the full set across many guilds is large.",
    inputSchema: {
        query: z.string().optional().describe("Case-insensitive substring filter on emoji name."),
        guildId: z.string().optional().describe("Narrow to one guild."),
        limit: z.number().int().min(1).max(200).optional().describe("Cap on results (default 25)."),
    },
}, async (args) => {
    const code =
        `(globalThis.$discordBridge && globalThis.$discordBridge.listEmoji)` +
        `  ? globalThis.$discordBridge.listEmoji(${JSON.stringify(args)})` +
        `  : (() => { throw new Error("DebugBridge listEmoji helper missing — plugin out of date; rebuild & redeploy.") })()`;
    return runInRenderer(code, 4);
});

mcp.registerTool("discord_unread", {
    description:
        "List channels with unread messages — the \"what did I miss?\" lookup. Always " +
        "scans DMs + group DMs; pass `includeGuilds: true` to also walk every guild text " +
        "channel the user has access to (heavier — only when needed). Each entry: " +
        "`{ channelId, kind, name, guildId, guildName, unreadCount, mentionCount, " +
        "oldestUnreadId, lastReadMessageId }`. Sorted by mentions, then unread count. " +
        "Pass `mentionsOnly: true` to only return channels where someone pinged the " +
        "viewer. Pipe a channelId into `discord_history({ after: oldestUnreadId })` to " +
        "see exactly what was missed.",
    inputSchema: {
        includeGuilds: z.boolean().optional().describe("Also scan guild text channels (default false — DMs/groups only)."),
        mentionsOnly: z.boolean().optional().describe("Only return channels with at least one mention (default false)."),
        limit: z.number().int().min(1).max(500).optional().describe("Cap on results (default 100)."),
    },
}, async (args) => {
    const code =
        `(globalThis.$discordBridge && globalThis.$discordBridge.unread)` +
        `  ? globalThis.$discordBridge.unread(${JSON.stringify(args)})` +
        `  : (() => { throw new Error("DebugBridge unread helper missing — plugin out of date; rebuild & redeploy.") })()`;
    return runInRenderer(code, 4, 30_000);
});

mcp.registerTool("discord_ack", {
    description:
        "Mark a channel read up to a message — REST " +
        "`POST /channels/{id}/messages/{messageId}/ack`. Clears unread badges " +
        "user-visibly. Not destructive per se, but DOES mutate visible state — only " +
        "call when the user explicitly asks to mark something read, or after they've " +
        "obviously caught up on a channel via the agent. Omit `messageId` to ack the " +
        "channel's most recent message.",
    inputSchema: {
        channelId: z.string().describe("Channel to mark read."),
        messageId: z.string().optional().describe("Ack up to this message ID. Omit for the channel's most recent message."),
    },
}, async (args) => {
    const code =
        `(globalThis.$discordBridge && globalThis.$discordBridge.ack)` +
        `  ? globalThis.$discordBridge.ack(${JSON.stringify(args)})` +
        `  : (() => { throw new Error("DebugBridge ack helper missing — plugin out of date; rebuild & redeploy.") })()`;
    return runInRenderer(code, 3, 15_000);
});

mcp.registerTool("discord_reload", {
    description:
        "Reload the Discord renderer (like Ctrl+R) and wait until the bridge reconnects and " +
        "Vencord/webpack are ready — one call. Use after deploying a Vencord plugin build, " +
        "or to recover a wedged renderer. The daemon is unaffected; only the renderer reloads.",
    inputSchema: {},
}, async () => {
    try {
        const res = await daemonFetch("/reload", { method: "POST" }, 45_000);
        const r = await res.json() as { ok: boolean; waitedMs: number; error?: string; renderer?: unknown };
        if (r.ok)
            return text(`Discord reloaded — bridge reconnected in ${r.waitedMs}ms.\n` +
                JSON.stringify(r.renderer, null, 2));
        return text(`Reload did not confirm reconnect (waited ${r.waitedMs}ms): ${r.error ?? "unknown"}`, true);
    } catch (e) {
        return text("Reload failed: " + errMsg(e), true);
    }
});

mcp.registerTool("discord_wait", {
    description:
        "Wait until a condition holds in the Discord renderer — a CSS `selector` appears in " +
        "the DOM, or a JS boolean `expr` is truthy. Polls until satisfied or `timeoutMs` " +
        "elapses. Use to synchronize after navigation, a click, or a reload.",
    inputSchema: {
        selector: z.string().optional().describe("CSS selector to wait for (≥1 element matches)."),
        expr: z.string().optional().describe("JS boolean expression to wait for, e.g. `!!window.Vencord`."),
        timeoutMs: z.number().int().min(500).max(120_000).optional().describe("Max wait (default 15000)."),
    },
}, async ({ selector, expr, timeoutMs }) => {
    if (!selector && !expr) return text("Provide `selector` or `expr`.", true);
    const check = selector ? `!!document.querySelector(${JSON.stringify(selector)})` : `(${expr})`;
    const probe = `(() => { try { return !!(${check}); } catch (e) { return "ERR:" + e.message; } })()`;
    const start = Date.now();
    const deadline = start + (timeoutMs ?? 15_000);
    let last = "";
    while (Date.now() < deadline) {
        try {
            const r = await daemonEval(probe, 2, 6000);
            if (r.ok && r.result === true) return text(`Condition met after ${Date.now() - start}ms.`);
            if (r.ok && typeof r.result === "string") last = r.result;
            else if (!r.ok) last = r.error ?? "";
        } catch (e) { last = errMsg(e); }
        await sleep(400);
    }
    return text(`Timed out after ${Date.now() - start}ms waiting for ` +
        (selector ? `selector ${selector}` : "expr") + (last ? ` (last: ${last})` : ""), true);
});

mcp.registerTool("discord_status", {
    description:
        "Report bridge health: is the daemon up, is the Discord DebugBridge plugin " +
        "connected, and a liveness snapshot of the renderer. Call this first when other " +
        "tools fail.",
    inputSchema: {},
}, async () => {
    let s: Record<string, unknown>;
    try {
        const res = await daemonFetch("/status", { method: "GET" }, 8000);
        s = await res.json() as Record<string, unknown>;
    } catch (e) {
        return text("Bridge daemon is unreachable: " + errMsg(e) +
            "\nThe daemon should auto-spawn — if this persists, check ~/discord-mcp-bridge/daemon.log.", true);
    }
    const uptime = Math.round((s.uptimeMs as number) / 1000);
    if (!s.pluginConnected)
        return text(
            `Daemon: UP (pid ${s.pid}, ${uptime}s uptime).\n` +
            "Discord plugin: DISCONNECTED — no recent poll.\n" +
            "Fix: start Discord, enable the DebugBridge Vencord plugin, then press Ctrl+R.");
    return text(
        `Daemon: UP (pid ${s.pid}, ${uptime}s uptime).  Discord plugin: CONNECTED.\n` +
        JSON.stringify(s, null, 2));
});

/* --------------------------------------------------------------- startup -- */

const transport = new StdioServerTransport();
void ensureDaemon().catch(e => log("ensureDaemon error: " + errMsg(e)));
mcp.connect(transport)
    .then(() => log("MCP stdio server ready"))
    .catch(e => log("MCP transport error: " + errMsg(e)));
