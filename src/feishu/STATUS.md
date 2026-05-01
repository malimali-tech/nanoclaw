# Feishu Integration — Work In Progress

This directory holds source code copied from `openclaw-lark` (the OpenClaw
Feishu/Lark plugin) that is being integrated into nanoclaw. The plan lives at
`/Users/haoyiqiang/.claude/plans/users-haoyiqiang-workspace-haoyiqiang-o-crispy-spring.md`.

**Status: NOT YET WIRED.** The whole `src/feishu/**` tree is excluded from
`tsconfig.json` and `eslint.config.js` while we build out the compat layer.
Nothing in the main process imports from here yet — the legacy
`src/channels/feishu.ts` channel is still the live one.

## Roadmap

The integration is split into the milestones below. Each milestone should land
as its own commit so the main branch stays buildable.

### M1 — Source import (DONE)
- [x] `src/feishu/**` populated from `openclaw-lark/src/`
- [x] `skills/feishu-*/` populated from `openclaw-lark/skills/`
- [x] `tsconfig.json` and `eslint.config.js` exclude `src/feishu/**`
- [x] `_origin-index.ts` preserved as the upstream entry-point reference

### M2 — Compat layer (TODO)
Replace every `from 'openclaw/plugin-sdk[/X]'` import with a nanoclaw-side
shim under `src/feishu/compat/`. The 21 subpaths to shim are:

  - `plugin-sdk` (root): `emptyPluginConfigSchema`, `ChannelPlugin`,
    `ClawdbotConfig`, `OpenClawPluginApi`, `PluginRuntime`, `RuntimeEnv`,
    `WizardPrompter`, `OpenClawConfig`, `ReplyPayload`, `RuntimeLogger`
  - `plugin-sdk/reply-runtime`: `SILENT_REPLY_TOKEN`, `ReplyDispatcher`
  - `plugin-sdk/reply-history`: `buildPendingHistoryContextFromMap`,
    `clearHistoryEntriesIfEnabled`, `DEFAULT_GROUP_HISTORY_LIMIT`,
    `HistoryEntry`
  - `plugin-sdk/channel-runtime`: `createReplyPrefixContext`,
    `createTypingCallbacks`
  - `plugin-sdk/channel-feedback`: `logTypingFailure`
  - `plugin-sdk/channel-status`: `PAIRING_APPROVED_MESSAGE`
  - `plugin-sdk/channel-contract`: `ChannelGroupContext`,
    `ChannelThreadingToolContext`
  - `plugin-sdk/channel-policy`: `GroupToolPolicyConfig`
  - `plugin-sdk/channel-send-result`: `ChannelOutboundAdapter`
  - `plugin-sdk/account-id`: `DEFAULT_ACCOUNT_ID`, `normalizeAccountId`
  - `plugin-sdk/agent-runtime`: `jsonResult`, `resolveDefaultAgentId`
  - `plugin-sdk/tool-send`: `extractToolSend`
  - `plugin-sdk/param-readers`: `readStringParam`
  - `plugin-sdk/plugin-runtime`: `dispatchPluginInteractiveHandler`
  - `plugin-sdk/allow-from`: `isNormalizedSenderAllowed`
  - `plugin-sdk/setup`: `addWildcardAllowFrom`, `formatDocsLink`,
    `ChannelSetupDmPolicy`, `ChannelSetupWizardAdapter`, `DmPolicy`
  - `plugin-sdk/config-runtime`: `loadSessionStore`,
    `resolveSessionStoreEntry`, `resolveStorePath`
  - `plugin-sdk/routing`: `resolveThreadSessionKeys`
  - `plugin-sdk/zalouser`: `resolveSenderCommandAuthorization`
  - `plugin-sdk/temp-path`: `buildRandomTempFilePath`

### M3 — Channel contract & streaming pipe (TODO)
- Add `StreamHandle` type and optional `Channel.openStream(jid)` to
  `src/types.ts`
- Update `src/agent/run.ts:139-148` to forward `text_delta` /
  `tool_call_*` / `reasoning_delta` events to `StreamHandle`
- Update `src/router.ts` with an `openStream(channels, jid)` helper

### M4 — LarkClient single-account refactor (TODO)
Drop `LarkClient.setRuntime(api.runtime)` model. Wire credentials from
`config/feishu.json` (multi-account, optional) with fallback to the existing
`FEISHU_APP_ID` / `FEISHU_APP_SECRET` env pair.

### M5 — Tool adapter + registration (TODO)
Implement `src/feishu/tool-adapter.ts` exposing a pi-coding-agent–compatible
`OpenClawPluginApi` shim. Hook `registerFeishuTools(piApi, ctx)` into
`src/agent/extension.ts`.

### M6 — Streaming card controller wiring (TODO)
`StreamingCardController` becomes the implementation of `Channel.openStream`
for Feishu. Forward `appendText` / `appendReasoning` / `appendToolUse` /
`finalize` calls into the controller.

### M7 — DB schema additions (TODO)
Add `feishu_sessions`, `feishu_tokens`, `feishu_dedup` tables to `src/db.ts`.

### M8 — Cutover (TODO)
- `src/channels/feishu.ts` becomes a thin re-export of `src/feishu/channel`
- `src/index.ts` calls `registerFeishu({ ports, db, ... })` at startup
- Remove `src/feishu/**` from tsconfig/eslint exclude lists
- `npm run install-feishu-skills` script copies skills into
  `~/.agents/skills/`

### M9 — End-to-end verification (TODO)
See the `Verification` section of the plan file.

## Notes for whoever continues this work

- `_origin-index.ts` is `openclaw-lark/index.ts` verbatim. Keep it as a
  reference, exclude from build, and write the real entrypoint as
  `src/feishu/index.ts` once M5 is done.
- `@sinclair/typebox`, `zod`, and `image-size` are upstream deps that are
  not yet in `nanoclaw/package.json`. Add them when M2 starts.
- The compat layer is the highest-risk milestone: each export above needs to
  be verified against actual openclaw upstream behaviour (the package isn't
  installed locally — read `node_modules/openclaw/...` once it is, or check
  upstream sources before stubbing).
