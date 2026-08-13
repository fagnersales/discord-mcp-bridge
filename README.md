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

1. **`daemon.ts`** — owns `0.0.0.0:8788` and the long-poll connection to the
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
./install.sh ~/Vencord      # bun install + copy discordMcp into Vencord
```

The installer copies the plugin instead of symlinking it. Vencord's esbuild
build follows symlinks to their real path; if the plugin source appears outside
the Vencord tree, aliases like `@api/Settings` and `@webpack` fail to resolve.
After editing files in `discordMcp/`, run `./install.sh ~/Vencord` again before
rebuilding Vencord.

If you use Vesktop and have other folders under `src/userplugins`, build with:

```bash
./build-vencord-discordmcp-only.sh ~/Vencord
```

Vencord builds every userplugin it finds. This helper temporarily moves other
userplugins aside, builds the dist with only DiscordMCP, then restores them in
the source tree.

Then register the MCP server with Claude Code (user scope) and restart it:

```bash
claude mcp add discord-bridge -s user -- "$(which bun)" "$PWD/server.ts"
```

Build & deploy Vencord, enable the **DiscordMCP** plugin in Vencord settings,
press `Ctrl+R` — `discord_status` should then report the plugin connected.

For Vesktop on macOS, "deploy" means copying the built dist into the dir
Vesktop actually loads Vencord from, then reloading:

```bash
cp ~/Vencord/dist/* "$HOME/Library/Application Support/vesktop/sessionData/vencordFiles/"
```

Keep Vencord's **autoUpdate** setting OFF (`settings/settings.json` →
`"autoUpdate": false`). With it on, any new upstream Vencord release gets
downloaded over `vencordFiles/` on reload, silently removing this plugin —
the bridge then reports "plugin DISCONNECTED" until you re-copy the dist.
If `discord_reload` can't reach a renderer whose plugin is already gone,
restart Vesktop itself (`osascript -e 'quit app "vesktop"' && open -a vesktop`).

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
- `discord_waitForMessage({channelId?, fromUserId?, contains?, mentionsViewer?, includeSelf?, maxMatches?, timeoutMs?})`
  — block until a new Discord message arrives that matches the filter (or until
  `timeoutMs` elapses, default 60 s, max 10 min). Subscribes inside the renderer
  to FluxDispatcher `MESSAGE_CREATE` — event-driven, no history polling.
  Catches messages in DMs, group DMs, and guild channels alike. Filters AND
  together; omit a filter to match anything in that dimension. Triggers on
  phrases like *"wait for a message"*, *"wait for his/her response"*,
  *"respond when X messages me"*, *"let me know when someone writes in this
  group"*. Default skips the viewer's own outgoing messages
  (`includeSelf: true` to include server-confirmed self-sends). Returns
  `{done, timedOut, matches: [{id, channelId, content, timestamp, author, …}]}`.
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
- `discord_join({invite, apply?})` — join a server from an invite (full URL or
  bare code). **Default is dry-run** — resolves the invite and returns the
  target guild / channel / inviter / member counts without joining. Pass
  `apply: true` to join. Idempotent (`alreadyMember: true` if already in). The
  returned `joined` boolean reflects the **live guild store**, not a guess.
  Large/flagged servers gate joins behind a captcha the bridge can't solve
  (cross-origin anti-bot iframe) — see *Captcha* below.
- `discord_onboarding({answerOptional?, allServers?, maxQuestions?})` —
  auto-complete the *"Question X of Y"* onboarding questionnaire shown right
  after joining a community server. Required questions get their first option
  selected then Next; optional questions are Skipped (`answerOptional: true` to
  answer them too). Scoped to the current server unless `allServers: true`
  (Discord chains several freshly-joined servers' onboarding back-to-back).
  Safe no-op (reports it) when no onboarding screen is up. Returns a
  per-question log.
- `discord_leave({guildId, apply?})` — leave a server by guild ID. Destructive.
  **Default is dry-run** — verifies membership and returns the resolved guild
  without leaving. Pass `apply: true` to actually leave; the returned `left`
  boolean reflects the **live guild store** (re-checked after the leave),
  not a guess.

### Config

- `discord_config({captchaCommand?, captchaTimeoutMs?, clearCaptcha?})` — read
  (no args) or update the config file at
  `~/.config/discord-mcp-bridge/config.json`. Currently holds the captcha
  solver hook.

#### Captcha

When `discord_join({apply:true})` hits a captcha, the bridge itself does **not**
click anything — it has no mouse/screen code and is OS-agnostic. Instead:

1. It detects the captcha and returns `captchaRequired: true`.
2. If a `captchaCommand` is configured, it shells out to that command, waits,
   then re-reads the guild store and reports the real `joined`.
3. With no command configured, it returns setup instructions — a human can
   solve the captcha in the Discord window, then re-run `discord_join` to
   confirm.

The command is **user-supplied and platform-specific** — it must locate and
solve the on-screen captcha itself (it gets `CAPTCHA_GUILD_ID` /
`CAPTCHA_GUILD_NAME` / `CAPTCHA_INVITE` in env + the same JSON on stdin, but
**no pixel coordinates** — those would break across resolutions / window
positions). Exit 0 once solved. A reference Windows solver (Interception-driver
mouse + RapidOCR checkbox locate) lives in
[`examples/solve-captcha.windows.ts`](examples/solve-captcha.windows.ts).
Note: auto-solving a captcha defeats Discord's anti-bot control — it is
inherently unreliable (works on a low-risk session, refused once flagged) and
carries account risk. The bridge falls back to a human cleanly rather than
faking success.

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

## Example — "wait for Kavi's response, then reply"

```text
discord_dms({ query: "kavi" })          → resolve channelId + userId
discord_waitForMessage({                → blocks until Kavi sends a message
  channelId, fromUserId,
  timeoutMs: 300_000,                   // 5 min
})
                                        → { matches: [{ id, content, … }] }
discord_send({                          → reply to that specific message
  channelId,
  replyToMessageId: matches[0].id,
  content: "...",
})
```

## HTTP endpoints (daemon, token required)

- `POST /poll` — plugin long-polls (held ≤25s) → `{id, code, depth}`.
- `POST /result` — plugin posts `{id, ok, result|error}`.
- `POST /eval?depth=N` — round-trip raw JS; the smoke-test path:

      curl -s -X POST 'http://localhost:8788/eval?token=vc-debug-bridge-2f9a4c1e' --data-binary 'document.title'

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
