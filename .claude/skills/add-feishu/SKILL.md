---
name: add-feishu
description: Add Feishu (飞书) / Lark as a channel. Can replace other channels entirely or run alongside them. Uses WebSocket long-connection (no public URL needed) via @larksuiteoapi/node-sdk.
---

# Add Feishu / Lark Channel

This skill adds Feishu (飞书) or Lark (国际版) support to NanoClaw, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/feishu.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Which edition do you want to connect to?

- **Feishu 国内版** (Recommended) — open.feishu.cn
- **Lark 国际版** — open.larksuite.com

AskUserQuestion: Do you already have a Feishu/Lark custom (自建) app, or do you need to create one?

If they already have one, collect the **App ID** and **App Secret** now. If not, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

### Ensure channel remote

```bash
git remote -v
```

If `feishu` is missing, add it:

```bash
git remote add feishu https://github.com/haoyiqiang/nanoclaw-feishu.git
```

### Merge the skill branch

```bash
git fetch feishu main
git merge feishu/main || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:

- `src/channels/feishu.ts` (`FeishuChannel` class with self-registration via `registerChannel`)
- `src/channels/feishu.test.ts` (24 unit tests with injected SDK deps)
- `import './feishu.js'` appended to the channel barrel file `src/channels/index.ts`
- `@larksuiteoapi/node-sdk` npm dependency in `package.json`
- `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, and `FEISHU_DOMAIN` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/channels/feishu.test.ts
```

All tests must pass (including the new Feishu tests) and the build must be clean before proceeding.

## Phase 3: Setup

### Create the Feishu / Lark App (if needed)

Tell the user:

> I need you to create a Feishu/Lark 自建应用 (custom app):
>
> 1. Open the developer console:
>    - Feishu 国内版: [open.feishu.cn/app](https://open.feishu.cn/app)
>    - Lark 国际版: [open.larksuite.com/app](https://open.larksuite.com/app)
> 2. **Create Custom App** (创建企业自建应用) and give it a name + icon.
> 3. Under **Add Features** (添加应用能力) → enable **Bot** (机器人).
> 4. Under **Permissions** (权限管理) → 开通 scopes:
>    - `im:message` (read messages)
>    - `im:message:send_as_bot` (send as bot)
>    - `im:chat` (read group info)
>    - `im:resource` (optional — read message resources)
> 5. Under **Event Subscriptions** (事件订阅):
>    - Subscribe to `im.message.receive_v1` (接收消息 v1.0)
>    - Enable **使用长连接接收事件 / Use WebSocket long-connection** (this is how NanoClaw receives events — no public URL is needed)
> 6. Under **Version Management & Release** (版本管理与发布) → create and release a version; wait for admin approval so the app is available to your organization.
> 7. Back on **Credentials & Basic Info** (凭证与基础信息), copy the **App ID** and **App Secret**.

Wait for the user to provide the App ID and App Secret.

### Configure environment

Add to `.env`:

```bash
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxx
# Use "lark" for the international edition; leave as "feishu" for 国内版.
FEISHU_DOMAIN=feishu
```

The channel auto-enables when both `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux (systemd)
# systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Add the bot to a chat and capture `chat_id`

Tell the user:

> 1. In Feishu/Lark, open the group where you want the assistant, then **Settings** → **Group Management** → **Add Members** → search for the app by name and add it. (For 1:1, search the bot in the sidebar and send a message.)
> 2. Send any message in that chat.
> 3. NanoClaw's log will print the `chat_id` on the first inbound message.

Capture the `chat_id` from the log:

```bash
tail -f logs/nanoclaw.log | grep 'feishu\] inbound chat_id='
```

Expected line: `[feishu] inbound chat_id=oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxx msg_id=om_xxxx`

Group chat IDs start with `oc_`; 1:1 chat IDs do not share that prefix but still work. The JID format for NanoClaw is:

```
feishu:<chat_id>
```

Wait for the user to provide the chat ID, then Ctrl+C out of `tail`.

### Register the chat

The chat ID, name, and folder name are needed. Use `npx tsx setup/index.ts --step register` with the appropriate flags.

For a main chat (responds to all messages):

```bash
npx tsx setup/index.ts --step register -- --jid "feishu:<chat-id>" --name "<chat-name>" --folder "feishu_main" --trigger "@${ASSISTANT_NAME}" --channel feishu --no-trigger-required --is-main
```

For additional chats (trigger-only):

```bash
npx tsx setup/index.ts --step register -- --jid "feishu:<chat-id>" --name "<chat-name>" --folder "feishu_<chat-name>" --trigger "@${ASSISTANT_NAME}" --channel feishu
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in your registered Feishu chat:
>
> - For a main chat: any message works.
> - For a non-main chat: `@<assistant-name> hello` (using the configured trigger word).
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

1. Check `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are set in `.env` **and** synced to `data/env/env` (`mkdir -p data/env && cp .env data/env/env`).
2. Check the chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'feishu:%'"`
3. For non-main chats: the message must include the trigger pattern (default `@<assistant-name>`).
4. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux).
5. Logs: `tail -50 logs/nanoclaw.log`.

### `invalid_app` / `app_not_online`

Your app version is still in draft or hasn't been approved by the org admin:

1. Open the developer console → **Version Management & Release** → create a version → submit for release.
2. Ask your tenant administrator to approve it under **应用管理后台 / Admin console**.
3. Restart NanoClaw after approval.

### WebSocket keeps disconnecting

SDK auto-reconnects; transient disconnects are normal. If it never stabilises:

1. Check the app still has the `im.message.receive_v1` event subscription and **使用长连接** is enabled.
2. Check the scopes haven't been revoked.
3. Regenerate `App Secret` only if you suspect a leak — this forces a reconnect and you must update `.env`.

### Can't find `chat_id`

1. Make sure the bot is actually in the group (members list).
2. Send **any** message in the chat — Feishu only delivers `im.message.receive_v1` for chats the bot is in.
3. Watch `logs/nanoclaw.log` for the `[feishu] inbound chat_id=…` line.

### Lark (国际版) instead of Feishu

Set `FEISHU_DOMAIN=lark` in `.env`, sync to `data/env/env`, and restart. The JID still uses the `feishu:` prefix — only the backend endpoint changes.

### Messages appear truncated

Long messages are split at a fixed 4000-character boundary. This may break mid-sentence. See Known Limitations.

## After Setup

If running `npm run dev` while the service is active:

```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Linux:
# systemctl --user stop nanoclaw
# npm run dev
# systemctl --user start nanoclaw
```

## Removal

To remove the Feishu integration:

1. Delete `src/channels/feishu.ts` and `src/channels/feishu.test.ts`.
2. Remove `import './feishu.js'` from `src/channels/index.ts`.
3. Remove `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, and `FEISHU_DOMAIN` from `.env`.
4. Remove Feishu registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'feishu:%'"`
5. Sync env: `mkdir -p data/env && cp .env data/env/env`.
6. Uninstall: `npm uninstall @larksuiteoapi/node-sdk`.
7. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux).

## Known Limitations

- **Text only** — Interactive cards (CardKit v1/v2), streaming card updates, and card action buttons are not implemented. Sending rich replies requires extending NanoClaw's `Channel` interface (`sendMessage(jid, text)` only accepts text today).
- **Images / files are placeholders** — Inbound images are delivered as `[image]`, files as `[file:<name>]`. The bot does not download or analyse the resource.
- **Threads are flattened** — `parent_id` is carried into `reply_to_message_id` for context, but replies from the bot are always sent to the chat, never back to a specific thread/topic root.
- **No typing indicator** — Feishu's Bot API does not expose a typing endpoint; `setTyping()` is a no-op.
- **Single account only** — Multi-workspace / multi-app setups are not supported. Run multiple NanoClaw instances if you need to connect several Feishu tenants.
- **WebSocket only** — The webhook (HTTP callback) transport is not implemented, so encrypt key / verification token are not used. WebSocket requires no public URL.
- **No OAuth / OAPI tools** — openclaw-lark's Device Flow, UAT management, and OpenAPI tools (calendar, task, drive, wiki, bitable) are not ported.
- **No reaction / comment / membership events** — Only `im.message.receive_v1` is subscribed. Reactions, drive comments, and bot-added/removed events are ignored.
- **Message splitting is naive** — Long responses are split at 4000 characters, which may break mid-word or mid-sentence.
