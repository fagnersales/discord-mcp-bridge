# discord-mcp-bridge

A live debugging bridge between a [Claude Code](https://claude.com/claude-code)
agent and a running Discord ([Vencord](https://github.com/Vendicated/Vencord))
client. Lets the agent inspect Discord's runtime — webpack modules, the DOM,
minified class names — and drive its UI, instead of guessing.

## Architecture — two processes, two roles

The bridge is split so the MCP tools **always** connect, no matter how many
Claude Code sessions are open:

1. **`daemon.ts`** — owns `0.0.0.0:8787` and the long-poll connection to the
   Vencord plugin. Long-lived and a **singleton**: only one process can bind
   the port; a second daemon loses the race and exits. Started **detached**
   (`setsid`) so it survives the Claude Code session that spawned it — and a
   Discord reload, since the daemon runs outside the renderer.
2. **`server.ts`** — the per-session **MCP stdio server**. Claude Code spawns
   one per session. It owns **no port**; every tool call is proxied over HTTP
   to the daemon. On startup it ensures the daemon is up, spawning it if not.
3. **`debugBridge/`** — the Vencord userplugin half. Runs in the Discord
   renderer and **long-polls** the daemon, evaluating the code the agent sends.

## Why HTTP, not WebSocket

The renderer cannot listen for connections, so it connects out. Discord's CSP
blocks `ws://localhost` (a schemeless/`http` `connect-src` source does not
permit an insecure `ws://` from an `https` page) but **allows
`http://localhost`** — so the transport is HTTP long-polling. The daemon also
sends `Access-Control-Allow-Origin` so the cross-origin `fetch` is readable.

## Install

Needs [Bun](https://bun.sh), Claude Code, and a Vencord **source build**.

```bash
git clone https://github.com/fagnersales/discord-mcp-bridge.git
cd discord-mcp-bridge
./install.sh ~/Vencord      # bun install + symlink debugBridge into Vencord
```

Then register the MCP server with Claude Code (user scope) and restart it:

```bash
claude mcp add discord-bridge -s user -- "$(which bun)" "$PWD/server.ts"
```

Build & deploy Vencord, enable the **DebugBridge** plugin in Vencord settings,
press `Ctrl+R` — `discord_status` should then report the plugin connected.

## MCP tools

- `discord_eval({code?, file?, depth?})` — eval JS in the renderer (expression
  or statements + `return`). `file` evals a local `.js` file; `depth` (1–20,
  default 8) sets result serialization depth.
- `discord_query(selector, limit?)` — querySelectorAll; returns tags/classes/HTML.
- `discord_findModule({code?, props?})` — search webpack modules (source / exports).
- `discord_open({channelId, messageId?})` — switch Discord to a channel
  (DM/group/guild). Same code path as the sidebar (`ChannelActions.selectChannel`);
  optional `messageId` scroll-jumps to that message. Confirms the selection
  actually flipped.
- `discord_dms({query?, limit?})` — list DMs and group DMs in sidebar order;
  with `query`, ranks matches by exact > prefix > substring across the DM name,
  recipient display names, and recipient usernames. Use to resolve "Kavi" →
  channelId before `discord_send`.
- `discord_view({limit?, includeEmbeds?, includeReactions?})` — read the selected
  channel and the messages currently rendered (works with scroll, since Discord
  virtualizes off-screen messages out of the DOM). Each message has author info,
  content, attachments, reply ref, mentions; `scroll.atBottom` tells you if the
  user is following live or browsing history.
- `discord_send({content?, channelId?, replyToMessageId?, files?, tts?})` — send
  a message natively via `MessageActions.sendMessage` / `UploadManager.uploadFiles`
  (not blocked by `isTrusted=false` the way `discord_click` is). `channelId`
  defaults to the currently selected channel; `files` are absolute paths.
- `discord_click(selector, index?)` — synthetic pointer/mouse/click on an element.
- `discord_key(combo, selector?)` — dispatch a key / shortcut, e.g. `"Ctrl+K"`.
- `discord_console(limit?)` — recent renderer warnings / errors / uncaught.
- `discord_screenshot({selector?, format?, maxWidth?, quality?})` — capture the
  renderer as an image (whole window, or one element); returns it inline so the
  agent can *see* the UI.
- `discord_reload()` — reload the renderer and wait until the bridge reconnects.
- `discord_wait({selector?, expr?, timeoutMs?})` — block until a selector
  appears or a JS boolean expression is truthy.
- `discord_status()` — daemon up? plugin connected? + renderer liveness snapshot.

## HTTP endpoints (daemon, token required)

- `POST /poll` — plugin long-polls (held ≤25s) → `{id, code, depth}`.
- `POST /result` — plugin posts `{id, ok, result|error}`.
- `POST /eval?depth=N` — round-trip raw JS; the smoke-test path:

      curl -s -X POST 'http://localhost:8787/eval?token=vc-debug-bridge-2f9a4c1e' --data-binary 'document.title'

- `POST /screenshot` — body `{selector?, ...}`; captures the renderer, returns
  `{ok, result:{data, mimeType, width, height, bytes}}` (`data` is base64).
- `GET /health` — daemon liveness (no plugin needed).
- `GET /status` — daemon + plugin + renderer snapshot.
- `POST /reload` — reload Discord, wait for reconnect.
- `POST /shutdown` — stop the daemon.

## Notes

- **Token:** `vc-debug-bridge-2f9a4c1e` is a localhost-only shared secret — it
  only stops other local pages from hitting the endpoint. To change it, edit
  the `TOKEN` constant in `daemon.ts`, `server.ts`, and `debugBridge/index.tsx`.
- The plugin polls `http://localhost`, falling back to `http://127.0.0.1`.
- Daemon logs to `daemon.log` in this directory.
- **Screenshots use a native helper** (`debugBridge/native.ts`,
  `webContents.capturePage()`). Native handlers register only at Discord
  **startup** — after first installing this, fully quit and reopen Discord
  once; `Ctrl+R` is not enough. After that, `Ctrl+R` works as before.
- **Security:** while enabled the plugin evals arbitrary JS inside Discord.
  Localhost-only + token. Keep it disabled when not actively debugging.

## License

GPL-3.0-or-later (the `debugBridge` plugin matches Vencord's license).
