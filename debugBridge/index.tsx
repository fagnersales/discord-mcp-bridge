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
            version: 8,
            console: consoleBuffer,
            isConnected: () => connected,
            isActive: () => settings.store.bridgeActive,
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
