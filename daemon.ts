#!/usr/bin/env bun
/**
 * discord-bridge daemon
 * ---------------------
 * Owns :8787 and the long-poll connection to the Vencord "DebugBridge" plugin.
 *
 * It is long-lived and a singleton: only one process can bind the port, and a
 * second daemon exits immediately on EADDRINUSE. server.ts (the per-session
 * MCP client) starts this detached (via `setsid`), so the daemon outlives any
 * single Claude Code session — and a Discord reload, since the daemon runs in
 * WSL and only the renderer reloads.
 *
 * This process never speaks MCP. It is pure HTTP. All logging goes to
 * daemon.log and stderr; there is no stdout protocol to protect.
 */

import { appendFileSync } from "fs";

const PORT = 8787;
const HOST = "0.0.0.0";                       // reachable from Windows-side Discord
const TOKEN = "vc-debug-bridge-2f9a4c1e";     // shared secret — must match the plugin
const CALL_TIMEOUT_MS = 12_000;               // how long a tool call waits for a result
const POLL_HOLD_MS = 25_000;                  // how long /poll is held open with no work
const PLUGIN_STALE_MS = 40_000;               // no poll within this -> plugin "disconnected"
const DEFAULT_DEPTH = 8;                      // result serialization depth when unspecified
const RELOAD_DEADLINE_MS = 35_000;            // how long /reload waits for Discord to return

const LOG_FILE = new URL("./daemon.log", import.meta.url).pathname;
const STARTED_AT = Date.now();

function log(...a: unknown[]) {
    const msg = a.map(x => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
    try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* */ }
    console.error("[discord-bridge-daemon]", ...a);
}
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/* ---------------------------------------------------------------- bridge -- */

interface Command { id: string; code: string; depth: number; }
interface BridgeReply { id: string; ok: boolean; result?: unknown; error?: string; }

let nextId = 1;
let lastPollAt = 0;
let pollSeq = 0;                                               // ++ on every /poll received
const commandQueue: Command[] = [];                            // queued, not yet polled
const pollWaiters: Array<(cmd: Command | null) => void> = [];  // parked /poll requests
const pending = new Map<string, {                              // tool calls awaiting a result
    resolve: (r: BridgeReply) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}>();

const pluginConnected = () => lastPollAt > 0 && Date.now() - lastPollAt < PLUGIN_STALE_MS;

/** Hand a command to a parked poll if one is waiting, else queue it. */
function deliver(cmd: Command) {
    const waiter = pollWaiters.shift();
    if (waiter) waiter(cmd);
    else commandQueue.push(cmd);
}

/** Queue code for the plugin and await its reply. */
function bridgeEval(code: string, depth = DEFAULT_DEPTH, timeoutMs = CALL_TIMEOUT_MS): Promise<BridgeReply> {
    return new Promise((resolve, reject) => {
        if (!pluginConnected()) {
            reject(new Error(
                "Discord bridge plugin is not connected (no recent poll). Make sure Discord " +
                "is running, Vencord is loaded, and the DebugBridge plugin is enabled " +
                "(press Ctrl+R in Discord after enabling it)."));
            return;
        }
        const id = String(nextId++);
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Bridge call timed out after ${timeoutMs}ms with no reply from the Discord plugin.`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        deliver({ id, code, depth });
    });
}

/**
 * Reload the Discord renderer and wait until the bridge reconnects and
 * Vencord/webpack are ready. The daemon itself is unaffected — only the
 * renderer reloads — so we just watch for a fresh poll from the new page.
 */
async function reloadAndWait(deadlineMs = RELOAD_DEADLINE_MS) {
    const start = Date.now();
    const pollSeqBefore = pollSeq;
    // Defer the reload a tick so the eval can ACK before the page tears down.
    try {
        await bridgeEval("setTimeout(() => location.reload(), 60); return 'reload-scheduled';", DEFAULT_DEPTH, 4000);
    } catch { /* the ACK may be lost as the page navigates away — expected */ }

    await sleep(1500);                          // let teardown begin
    while (Date.now() - start < deadlineMs) {
        if (pollSeq > pollSeqBefore && pluginConnected()) {
            try {
                const r = await bridgeEval(
                    "({ ready: !!(window.Vencord && Vencord.Webpack && Vencord.Webpack.wreq), " +
                    "title: document.title, href: location.href, " +
                    "pluginVersion: ((globalThis.$discordBridge||{}).version)||null })",
                    DEFAULT_DEPTH, 5000);
                if (r.ok && r.result && (r.result as { ready?: unknown }).ready) {
                    return { ok: true, waitedMs: Date.now() - start, renderer: r.result };
                }
            } catch { /* renderer still coming up — keep waiting */ }
        }
        await sleep(500);
    }
    return { ok: false, error: "Timed out waiting for Discord to reconnect after reload.", waitedMs: Date.now() - start };
}

/* ----------------------------------------------------------------- http -- */

const CORS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
};
const jsonCors = (data: unknown, status = 200) => Response.json(data, { status, headers: CORS });
const textCors = (body: string, status = 200) =>
    new Response(body, { status, headers: { ...CORS, "Content-Type": "text/plain" } });

/**
 * Long-poll: resolve with the next command, or null after POLL_HOLD_MS — or
 * null immediately if the client disconnects (page reload), so a stale waiter
 * never receives a command nobody will read.
 */
function awaitCommand(signal?: AbortSignal): Promise<Command | null> {
    lastPollAt = Date.now();
    pollSeq++;
    const queued = commandQueue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise(resolve => {
        let settled = false;
        const finish = (cmd: Command | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            const i = pollWaiters.indexOf(finish);
            if (i >= 0) pollWaiters.splice(i, 1);
            resolve(cmd);
        };
        const onAbort = () => finish(null);
        const timer = setTimeout(() => finish(null), POLL_HOLD_MS);
        signal?.addEventListener("abort", onAbort);
        pollWaiters.push(finish);
    });
}

function statusSnapshot() {
    return {
        daemon: true,
        pid: process.pid,
        uptimeMs: Date.now() - STARTED_AT,
        port: PORT,
        pluginConnected: pluginConnected(),
        lastPollAgeMs: lastPollAt ? Date.now() - lastPollAt : null,
        pendingCalls: pending.size,
        queuedCommands: commandQueue.length,
    };
}

async function handleHttp(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.searchParams.get("token") !== TOKEN) return textCors("unauthorized", 401);

    // plugin long-polls here for the next command
    if (req.method === "POST" && url.pathname === "/poll") {
        const cmd = await awaitCommand(req.signal);
        return cmd ? jsonCors(cmd) : new Response(null, { status: 204, headers: CORS });
    }

    // plugin posts an eval result here
    if (req.method === "POST" && url.pathname === "/result") {
        let reply: BridgeReply;
        try { reply = JSON.parse(await req.text()); } catch { return textCors("bad json", 400); }
        const p = reply && typeof reply.id === "string" ? pending.get(reply.id) : undefined;
        if (p) {
            pending.delete(reply.id);
            clearTimeout(p.timer);
            p.resolve(reply);
        }
        return textCors("ok");
    }

    // cheap liveness check — daemon up? (no plugin needed)
    if (url.pathname === "/health") {
        return jsonCors({ ok: true, daemon: true, pid: process.pid, uptimeMs: Date.now() - STARTED_AT });
    }

    // full status — daemon + plugin + renderer snapshot
    if (url.pathname === "/status") {
        const base = statusSnapshot();
        if (!pluginConnected()) return jsonCors({ ...base, renderer: null });
        try {
            const r = await bridgeEval(`({
                title: document.title,
                href: location.href,
                hasVencord: typeof Vencord !== "undefined",
                webpackReady: !!(typeof Vencord !== "undefined" && Vencord.Webpack && Vencord.Webpack.wreq),
                pluginVersion: ((globalThis.$discordBridge || {}).version) || null,
                consoleBuffered: ((globalThis.$discordBridge || {}).console || []).length,
            })`, DEFAULT_DEPTH, 5000);
            return jsonCors({ ...base, renderer: r.ok ? r.result : { error: r.error } });
        } catch (e) {
            return jsonCors({ ...base, renderer: { error: errMsg(e) } });
        }
    }

    // reload Discord and wait for the bridge to come back
    if (req.method === "POST" && url.pathname === "/reload") {
        return jsonCors(await reloadAndWait());
    }

    // eval raw JS in the renderer; ?depth=N controls result serialization depth
    if (req.method === "POST" && url.pathname === "/eval") {
        const code = await req.text();
        if (!code.trim()) return jsonCors({ ok: false, error: "empty body" }, 400);
        const depthRaw = parseInt(url.searchParams.get("depth") ?? "", 10);
        const depth = Number.isFinite(depthRaw) ? Math.max(1, Math.min(20, depthRaw)) : DEFAULT_DEPTH;
        try { return jsonCors(await bridgeEval(code, depth)); }
        catch (e) { return jsonCors({ ok: false, error: errMsg(e) }, 502); }
    }

    // manual cleanup hook
    if (req.method === "POST" && url.pathname === "/shutdown") {
        log("shutdown requested via /shutdown");
        setTimeout(() => process.exit(0), 50);
        return textCors("shutting down");
    }

    return textCors(`discord-bridge daemon ok — plugin ${pluginConnected() ? "connected" : "NOT connected"}`);
}

try {
    Bun.serve({ port: PORT, hostname: HOST, idleTimeout: 120, fetch: handleHttp });
    log(`daemon listening on http://${HOST}:${PORT} (pid ${process.pid})`);
} catch (e) {
    // EADDRINUSE — another daemon already owns the port. This is the singleton
    // election: the loser exits cleanly so only one daemon ever runs.
    log(`port ${PORT} already owned by another daemon — exiting. (${errMsg(e)})`);
    process.exit(0);
}
