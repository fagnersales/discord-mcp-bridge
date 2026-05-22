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
 * Renderer-only, no patches: after enabling/disabling just press Ctrl+R.
 *
 * SECURITY: while enabled, this evaluates arbitrary JavaScript inside your
 * Discord client. It only talks to localhost and authenticates with a shared
 * token. Keep it DISABLED unless you are actively using the bridge.
 */

import definePlugin, { PluginNative } from "@utils/types";

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

let stopped = false;
let baseIndex = 0;
let connected = false;
let currentAbort: AbortController | undefined;

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
        connected = false;
        baseIndex++;                       // network / abort error — try the other host next
        throw e;
    } finally {
        clearTimeout(abortTimer);
    }

    if (!connected) origConsole.warn?.call(console, "[DebugBridge] connected:", base);
    connected = true;

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

async function pollLoop(): Promise<void> {
    while (!stopped) {
        try {
            await pollOnce();
        } catch {
            connected = false;
            if (!stopped) await sleep(BACKOFF_MS);
        }
    }
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

/* -------------------------------------------------------------- plugin -- */

export default definePlugin({
    name: "DebugBridge",
    description:
        "Live debugging bridge — lets a local Claude Code agent inspect and eval inside " +
        "this Discord client over localhost HTTP (token-gated). Keep disabled when not in use.",
    authors: [{ name: "fagner", id: 0n }],

    start() {
        stopped = false;
        baseIndex = 0;
        connected = false;
        consoleBuffer.length = 0;
        installConsoleCapture();
        (globalThis as any).$discordBridge = {
            version: 4,
            console: consoleBuffer,
            isConnected: () => connected,
        };
        void pollLoop();
    },

    stop() {
        stopped = true;
        connected = false;
        try { currentAbort?.abort(); } catch { /* */ }
        currentAbort = undefined;
        removeConsoleCapture();
        delete (globalThis as any).$discordBridge;
    },
});
