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
import { readFileSync } from "fs";

const PORT = 8787;
const TOKEN = "vc-debug-bridge-2f9a4c1e";
const BASE = `http://127.0.0.1:${PORT}`;
const DAEMON_PATH = new URL("./daemon.ts", import.meta.url).pathname;

const log = (...a: unknown[]) => console.error("[discord-bridge-mcp]", ...a);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

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
    const path = depth ? `/eval?depth=${depth}` : "/eval";
    const res = await daemonFetch(path, { method: "POST", body: code }, timeoutMs);
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
        return text(typeof r === "string" ? r : (JSON.stringify(r, null, 2) ?? "undefined"));
    }
    return text("Discord renderer error:\n" + (reply.error ?? "unknown error"), true);
}

async function runInRenderer(code: string, depth?: number): Promise<ToolResult> {
    try {
        return formatReply(await daemonEval(code, depth));
    } catch (e) {
        return text("Bridge error: " + errMsg(e), true);
    }
}

const mcp = new McpServer({ name: "discord-bridge", version: "2.1.0" });

mcp.registerTool("discord_eval", {
    description:
        "Evaluate JavaScript inside the running Discord (Vencord) renderer and return the " +
        "result. Runs in global scope with access to `Vencord`, `document`, `window`, etc. " +
        "`await` is supported. Pass a single expression (e.g. `document.title`) OR several " +
        "statements with an explicit `return`. Results are cycle-safe and serialized to " +
        "`depth` levels (default 8); DOM nodes return as { tag, classes, outerHTML }.",
    inputSchema: {
        code: z.string().optional().describe("JavaScript to evaluate. Provide this or `file`."),
        file: z.string().optional().describe("Absolute path to a .js file to evaluate instead of `code`."),
        depth: z.number().int().min(1).max(20).optional().describe("Result serialization depth (default 8)."),
    },
}, async ({ code, file, depth }) => {
    let src = code;
    if (file) {
        try { src = readFileSync(file, "utf8"); }
        catch (e) { return text("Could not read file: " + errMsg(e), true); }
    }
    if (!src || !src.trim()) return text("Provide `code` or `file`.", true);
    return runInRenderer(src, depth);
});

mcp.registerTool("discord_query", {
    description:
        "Run document.querySelectorAll for a CSS selector in the Discord renderer; returns " +
        "matched elements as { tag, id, classes, text, outerHTML }. Use it to discover " +
        "Discord's minified CSS class names for a UI element.",
    inputSchema: {
        selector: z.string().describe(`CSS selector, e.g. [class*="chatContent"].`),
        limit: z.number().int().min(1).max(50).optional().describe("Max elements to return (default 15)."),
    },
}, async ({ selector, limit }) => runInRenderer(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
    return {
        count: els.length,
        elements: els.slice(0, ${limit ?? 15}).map(el => ({
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            classes: [...el.classList],
            text: (el.textContent || "").trim().slice(0, 100),
            outerHTML: el.outerHTML.slice(0, 700),
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
                keys: Object.keys(m).slice(0, 200),
                values: Object.fromEntries(Object.entries(m).slice(0, 200)
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
                            snippet: src.slice(Math.max(0, idx - 240), idx + 520),
                        });
                        if (hits.length >= 8) break;
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
        "Click an element in the Discord renderer (a button, menu item, etc.). Dispatches a " +
        "full synthetic pointer/mouse/click sequence on the element matching the selector. " +
        "Good for driving Discord's UI and testing buttons. Note: synthetic events are " +
        "isTrusted=false — they work for most UI, but Discord ignores them on guarded " +
        "actions such as sending a message.",
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
        "Dispatch a keyboard event / shortcut in the Discord renderer — e.g. \"Ctrl+K\" " +
        "(quick switcher), \"Escape\", \"ArrowDown\", \"Ctrl+Shift+M\". Dispatches " +
        "keydown/keypress/keyup on the target (a CSS selector, or the focused element). " +
        "Good for testing Discord's keyboard shortcuts. Note: synthetic events are " +
        "isTrusted=false — they drive most shortcuts, but Discord ignores them on guarded " +
        "actions such as Enter-to-send in the message box.",
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
        "Return recent console warnings/errors and uncaught exceptions captured from the " +
        "Discord renderer (oldest first, newest last). Check this after an eval, or after " +
        "a plugin/Vencord change, to see what was logged.",
    inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("Max entries to return (default 40)."),
    },
}, async ({ limit }) => runInRenderer(
    `((globalThis.$discordBridge && globalThis.$discordBridge.console) || []).slice(-${limit ?? 40})`));

mcp.registerTool("discord_screenshot", {
    description:
        "Capture a screenshot of the running Discord (Vencord) renderer and return it as an " +
        "image. Use it to SEE the UI — verify a layout/styling change, inspect a component, " +
        "or debug a visual bug — instead of guessing from the DOM. Pass `selector` to capture " +
        "a single element (it is scrolled into view first); omit it for the whole window. " +
        "Only the currently-visible viewport is captured; scroll or navigate first if needed.",
    inputSchema: {
        selector: z.string().optional().describe("CSS selector of one element to capture; omit for the full window."),
        format: z.enum(["png", "jpeg"]).optional().describe("Image format (default png; jpeg is smaller)."),
        maxWidth: z.number().int().min(64).max(4096).optional().describe("Scale down so width ≤ this many px (default 1600)."),
        quality: z.number().int().min(1).max(100).optional().describe("JPEG quality 1–100 (default 85; ignored for png)."),
    },
}, async ({ selector, format, maxWidth, quality }) => {
    try {
        const res = await daemonFetch("/screenshot", {
            method: "POST",
            body: JSON.stringify({ selector, format, maxWidth, quality }),
        }, 35_000);
        const reply = (await res.json()) as BridgeReply;
        if (!reply.ok)
            return text("Screenshot failed:\n" + (reply.error ?? "unknown error"), true);
        const r = reply.result as { data: string; mimeType: string; width: number; height: number; bytes: number };
        return {
            content: [
                { type: "image", data: r.data, mimeType: r.mimeType },
                {
                    type: "text",
                    text: `Captured ${r.width}×${r.height}px ${r.mimeType} (${Math.round(r.bytes / 1024)} KB)` +
                        (selector ? ` of \`${selector}\`.` : "."),
                },
            ],
        };
    } catch (e) {
        return text("Screenshot error: " + errMsg(e), true);
    }
});

mcp.registerTool("discord_reload", {
    description:
        "Reload the Discord renderer (equivalent to pressing Ctrl+R) and wait until the " +
        "bridge reconnects and Vencord/webpack are ready again — all in one call. Use this " +
        "after deploying a new Vencord plugin build to load it, or to recover a wedged " +
        "renderer. The bridge daemon is unaffected; only the renderer reloads.",
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
        "Wait until a condition becomes true in the Discord renderer — either a CSS " +
        "`selector` appears in the DOM, or a JS boolean `expr` evaluates truthy. Polls " +
        "until satisfied or `timeoutMs` elapses. Use it to synchronize after navigation, " +
        "a click, or a reload before the next step.",
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
