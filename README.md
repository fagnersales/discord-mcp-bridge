# discord-mcp-bridge

A live bridge between a [Claude Code](https://claude.com/claude-code) agent and
a running Discord ([Vencord](https://github.com/Vendicated/Vencord)) client.
The agent can **interact** with Discord — list DMs by name, open a channel,
read the messages you are currently looking at, and send a message (with a
pretend-typing indicator, attachments, reply refs) — and **inspect** its
runtime (webpack modules, the DOM, minified class names) instead of guessing.

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
3. **`discordMcp/`** — the Vencord userplugin half. Runs in the Discord
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
./install.sh ~/Vencord      # bun install + symlink discordMcp into Vencord
```

Then register the MCP server with Claude Code (user scope) and restart it:

```bash
claude mcp add discord-bridge -s user -- "$(which bun)" "$PWD/server.ts"
```

Build & deploy Vencord, enable the **DiscordMCP** plugin in Vencord settings,
press `Ctrl+R` — `discord_status` should then report the plugin connected.

## MCP tools

### Interaction — talk to people

- `discord_dms({query?, limit?})` — list DMs and group DMs in sidebar order.
  With `query`, ranks matches by exact > prefix > substring across the DM
  display name, recipient global / username, **and the Discord friend-nickname
  the sidebar actually shows** (via `RelationshipStore.getNickname`) — so a
  query for "Dragãozinha" resolves even when the underlying account is
  "pitucoco".
- `discord_open({channelId, messageId?})` — switch Discord to a channel
  (DM / group / guild). Same code path as the sidebar
  (`ChannelActions.selectChannel`); optional `messageId` scroll-jumps to that
  message. Confirms the selection actually flipped.
- `discord_view({limit?, includeEmbeds?, includeReactions?})` — read what the
  user is currently looking at: the selected channel + the messages rendered
  in the viewport. Discord virtualizes off-screen messages out of the DOM, so
  this is naturally scroll-scoped — if the user scrolled up to look at
  history, *that* slice is what comes back. Each message includes author info,
  content, timestamp, attachments, reply ref, mentions; `scroll.atBottom`
  tells you if the user is following live or browsing history.
- `discord_send({content?, channelId?, replyToMessageId?, files?, tts?, typing?, typingMs?})`
  — send a message natively via `MessageActions.sendMessage` (or
  `UploadManager.uploadFiles` when files are attached). Same code path as
  Discord's composer, so it is **not** blocked by `isTrusted=false` the way
  `discord_click` is. `channelId` defaults to the currently selected channel.
  Set `typing: true` to show the typing indicator first (duration auto-derived
  from content length, ~60ms/char clamped to 800–6000 ms) or `typingMs: N`
  for an explicit duration — feels less robotic than instant sends.
- `discord_guilds()` — read the left-sidebar layout: top-level guilds and
  folders in display order. Each entry is
  `{kind:"guild", guildId, name}` or
  `{kind:"folder", id, name, color, expanded, guildIds, guilds:[{id,name}]}`.
  `color` is a 24-bit RGB integer (the Discord folder swatch). A separate
  `orphans` array lists guilds the user is in but not referenced by any
  entry (Discord parks newly-joined guilds there).
- `discord_organize({sidebar, apply?})` — rewrite the sidebar layout: reorder,
  group into folders, rename / recolor folders, ungroup, move guilds between
  folders. `sidebar` is the full ordered list of top-level entries; every
  guild in `GuildStore` must appear exactly once across all entries. Entry
  forms: `{kind:"guild", guildId}` (top-level) or
  `{kind:"folder", guildIds:[...], name?, color?, id?}` (folder). Pass an
  existing folder's `id` from `discord_guilds` to preserve expand/collapse
  state; omit it to auto-mint. **Default is dry-run** — returns the resolved
  preview without writing. Pass `apply: true` to commit via Discord's user
  settings proto (syncs to the user's other Discord clients). The tool rejects
  unknown guildIds — strip "ghost" entries (left guilds still in proto) before
  retrying; append new joins (`orphans`) explicitly so they aren't dropped.

### Inspection — debug Discord

- `discord_eval({code?, file?, depth?})` — eval JS in the renderer (expression
  or statements + `return`). `file` evals a local `.js` file; `depth` (1–20,
  default 8) sets result serialization depth.
- `discord_query(selector, limit?)` — querySelectorAll; returns tags/classes/HTML.
- `discord_findModule({code?, props?})` — search webpack modules (source / exports).
- `discord_screenshot({selector?, format?, maxWidth?, quality?})` — capture the
  renderer as an image (whole window, or one element); returns it inline so the
  agent can *see* the UI.
- `discord_console(limit?)` — recent renderer warnings / errors / uncaught.
- `discord_click(selector, index?)` — synthetic pointer/mouse/click on an element.
- `discord_key(combo, selector?)` — dispatch a key / shortcut, e.g. `"Ctrl+K"`.
- `discord_wait({selector?, expr?, timeoutMs?})` — block until a selector
  appears or a JS boolean expression is truthy.
- `discord_reload()` — reload the renderer and wait until the bridge reconnects.
- `discord_status()` — daemon up? plugin connected? + renderer liveness snapshot.

### Memory — personal context across sessions

- `discord_notes({action, key?, value?, topic?, userId?, channelId?})` —
  a tiny persistent notebook so the agent can remember things about
  *you* across sessions: writing style, recurring contacts, group
  conventions, preferences. Actions are `save` / `recall` / `forget`.
  Each note can be tagged with a `userId` and/or `channelId`, anchoring
  it to a specific person / DM / channel — and many notes can share
  the same id. `recall` with no filter dumps every saved note grouped
  by topic (good at session start); `recall` with a `userId` /
  `channelId` / `topic` filter returns just the matching slice, so
  after resolving "main group" to a channelId the agent can pull
  *only* the notes about that group. Stored locally as `notes.json`
  next to the bridge; nothing leaves the machine.

## Example — "reply to Kavi based on what we've been talking about"

```text
discord_dms({ query: "kavi" })          → grab the 1:1 channelId
discord_open({ channelId })             → switch Discord to it
discord_view({ limit: 30 })             → read recent messages for context
discord_send({                          → reply, with a natural typing pause
  channelId, content: "...",
  replyToMessageId: "...",
  typing: true,
})
```

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
  the `TOKEN` constant in `daemon.ts`, `server.ts`, and `discordMcp/index.tsx`.
- The plugin polls `http://localhost`, falling back to `http://127.0.0.1`.
- Daemon logs to `daemon.log` in this directory.
- **Screenshots use a native helper** (`discordMcp/native.ts`,
  `webContents.capturePage()`). Native handlers register only at Discord
  **startup** — after first installing this, fully quit and reopen Discord
  once; `Ctrl+R` is not enough. After that, `Ctrl+R` works as before.
- **Security:** while enabled the plugin evals arbitrary JS inside Discord.
  Localhost-only + token. Keep it disabled when not actively debugging.

## License

GPL-3.0-or-later (the `discordMcp` plugin matches Vencord's license).
