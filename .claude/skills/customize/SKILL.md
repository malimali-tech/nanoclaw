---
name: customize
description: Add new capabilities or modify NanoClaw behavior. Use when user wants to add a new input channel, change triggers, add integrations, modify the router, or make any other customizations. This is an interactive skill that asks questions to understand what the user wants.
---

# NanoClaw Customization

This skill helps users add capabilities or modify behavior. Use AskUserQuestion to understand what they want before making changes.

## Workflow

1. **Understand the request** — ask clarifying questions
2. **Plan the changes** — identify files to modify. Reuse existing patterns rather than inventing parallel ones.
3. **Implement** — make changes directly to the code
4. **Test guidance** — tell the user how to verify

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation, channel wiring |
| `src/channels/feishu.ts` | The built-in Feishu / Lark channel — reference implementation of the `Channel` interface |
| `src/channels/registry.ts` | Channel self-registration registry |
| `src/router.ts` | Message formatting + outbound routing helpers |
| `src/group-log.ts` | Per-group `log.jsonl` append/tail/cursor (used for inbound + bot replies) |
| `src/types.ts` | TypeScript interfaces (`Channel`, `NewMessage`, `RegisteredGroup`, …) |
| `src/config.ts` | Assistant name, trigger pattern, directories |
| `src/db.ts` | SQLite for scheduled tasks / sessions / registered groups |
| `groups/main/CLAUDE.md` | Main-group persona + admin context |
| `groups/global/CLAUDE.md` | Global memory copied into every new group |

## Common Customization Patterns

### Adding a new input channel

Questions to ask:
- Which channel?
- Same trigger word as the assistant default, or per-group override?
- Should messages share the existing main group, or create separate groups?

Implementation pattern (study `src/channels/feishu.ts` first):
1. Create `src/channels/<name>.ts` exporting a class that implements the `Channel` interface from `src/types.ts` (`name`, `connect`, `disconnect`, `sendMessage`, `isConnected`, `ownsJid`, optional `setTyping`).
2. The class constructor takes `ChannelOpts` (`onMessage` + `registeredGroups`). Inbound messages go through `channelOpts.onMessage(jid, NewMessage)`.
3. Choose a JID prefix (Feishu uses `feishu:`, Telegram conventionally `tg:`, Discord `dc:`, etc.) so `ownsJid` can filter cleanly.
4. At the bottom of the new file, call `registerChannel('<name>', factory)` from `src/channels/registry.ts`. The factory reads credentials from `.env` and returns `null` if they're missing — that lets unconfigured channels self-disable.
5. Add `import './<name>.js';` to `src/channels/index.ts`.
6. Add channel-specific env vars to `.env` and `.env.example`.
7. Append the SDK to `package.json` and `npm install`.
8. Test with `npm run dev`, send a message, check `tail -f logs/nanoclaw.log` and `groups/<folder>/.nanoclaw/log.jsonl`.

### Adding a new agent tool / capability

Tools live as `pi-coding-agent` extensions. See `src/agent/extension.ts` for `nanoclawExtension(ctx)` — it registers `send_message`, `schedule_task`, `register_group`, etc. To add a tool:
1. Add a new `pi.registerTool(defineTool({...}))` block.
2. Wire any host-side dependency through `ExtensionCtx` (currently `router`, `taskScheduler`, `groupRegistry`, `channels`).
3. Document it in `groups/global/CLAUDE.md` so the agent knows it exists.

### Changing assistant behavior

- Name / trigger word — `ASSISTANT_NAME` in `.env` (or `src/config.ts` defaults).
- Persona — `groups/main/CLAUDE.md` for the main group, `groups/global/CLAUDE.md` for the template applied to new groups.
- Per-group behavior — edit `groups/<folder>/CLAUDE.md`.
- Routing semantics (trigger matching, allowlist, main-group privileges) — `src/index.ts:processGroupMessages` and `src/sender-allowlist.ts`.

### Adding a new MCP integration

NanoClaw runs `@mariozechner/pi-coding-agent` in-process. Configure MCP servers via the standard pi-coding-agent / pi-mono mechanisms (e.g. `~/.pi/agent/config.json` or pi extensions). The agent picks them up at session creation time inside `src/agent/run.ts:buildSession`.

### Changing deployment

- Service file — `setup/service.ts` generates a launchd plist (macOS) or systemd unit (Linux). Edit there for env vars, log paths, restart policy.
- Sandbox profile — `config/sandbox.default.json` (network/filesystem rules) + per-group override at `groups/<folder>/.pi/sandbox.json`.
- Mount allowlist — `~/.config/nanoclaw/mount-allowlist.json`.

## After Changes

```bash
npm run build
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux (user)
# systemctl --user restart nanoclaw
```

Then send a test message and watch `tail -f logs/nanoclaw.log`.

## Example Interaction

User: "Add Telegram as an input channel"

1. Confirm prerequisites — bot token from @BotFather, target chat ID.
2. Create `src/channels/telegram.ts` modeled on `src/channels/feishu.ts` (use `grammy` or `node-telegram-bot-api` for transport).
3. Pick JID prefix `tg:`; `ownsJid(jid)` returns `jid.startsWith('tg:')`.
4. Add `import './telegram.js';` to `src/channels/index.ts`.
5. Add `TELEGRAM_BOT_TOKEN` to `.env`.
6. Build, restart, send `/start` to the bot, observe `[telegram] inbound chat_id=…` in the log, register the chat with `npx tsx setup/index.ts --step register -- --jid 'tg:<id>' --name 'My Chat' --folder telegram_main --is-main`.
