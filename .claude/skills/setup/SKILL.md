---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate messaging channels, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Drive setup directly from this skill: do all checks via Read/Bash, only delegate to `npx tsx setup/index.ts --step <name>` when the step has real complexity worth scripting (currently only `service`, used to generate the launchd plist or systemd unit). The bootstrap script `setup.sh` runs once before Node is guaranteed to exist.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. authenticating a channel, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX:** Use `AskUserQuestion` only for multiple-choice. Free-text input (tokens, paths, phone numbers) — ask in plain text and wait.

## 0. Git & Fork Setup

`git remote -v` and branch:

- **`origin` is `qwibitai/nanoclaw`** (user cloned, didn't fork): AskUserQuestion "Set up a fork now?". If yes, ask for GitHub username, then:
  ```bash
  git remote rename origin upstream
  git remote add origin https://github.com/<username>/nanoclaw.git
  git push --force origin main
  ```
  If they say no: `git remote add upstream https://github.com/qwibitai/nanoclaw.git` so updates still flow.

- **`origin` is the user's fork, no `upstream`**: `git remote add upstream https://github.com/qwibitai/nanoclaw.git`

- **Both `origin` (fork) and `upstream` exist**: continue.

## 1. Bootstrap (Node + deps)

`bash setup.sh` and parse the status block.

- `NODE_OK=false` → AskUserQuestion to install Node 22. macOS: `brew install node@22` or nvm. Linux: NodeSource setup script or nvm. Re-run `bash setup.sh`.
- `DEPS_OK=false` → read `logs/setup.log`, delete `node_modules`, re-run. If native module build fails, install build tools (`xcode-select --install` / `apt install build-essential`) and retry.
- `NATIVE_OK=false` → better-sqlite3 didn't load. Same fix as above.

Record `PLATFORM` and `IS_WSL`.

## 2. OpenClaw Migration Detection

```bash
ls -d ~/.openclaw 2>/dev/null || ls -d ~/.clawdbot 2>/dev/null
```

If found, AskUserQuestion: **Migrate now** / **Fresh start** / **Migrate later**. "Migrate now" → invoke `/migrate-from-openclaw`, then return here.

## 3. Environment Sanity (do it directly)

You don't need a script — run these and decide:

```bash
# Platform/Docker
uname -s              # darwin / linux
which docker && docker info >/dev/null 2>&1 && echo "docker:running" || echo "docker:not-running"

# Existing config
[ -f .env ] && echo "has .env" || echo "no .env"
[ -d store/auth ] && [ "$(ls -A store/auth 2>/dev/null)" ] && echo "has auth" || echo "no auth"

# Existing registered groups (skip if no DB yet)
[ -f store/messages.db ] && \
  node -e "const Database = require('better-sqlite3'); try { const db = new Database('store/messages.db', {readonly:true}); const r = db.prepare('SELECT COUNT(*) AS c FROM registered_groups').get(); console.log('registered_groups:', r.c); } catch(e){ console.log('registered_groups: 0'); }"
```

If `.env` exists and `registered_groups > 0`: this looks like a re-setup. AskUserQuestion whether to **Reconfigure** or **Skip ahead to verify**.

## 4. Timezone

```bash
node -p "Intl.DateTimeFormat().resolvedOptions().timeZone"
```

If the result is a valid IANA name (contains `/`, e.g. `Asia/Shanghai`, `America/New_York`), record it as `RESOLVED_TZ`. Otherwise (POSIX-style like `IST-2`, or empty), AskUserQuestion with common options + Other.

Then write to `.env`:

```bash
# preserve existing keys; only add/update TZ
if grep -q '^TZ=' .env 2>/dev/null; then
  # use sed -i (macOS needs '' arg)
  perl -i -pe 's/^TZ=.*/TZ='"$RESOLVED_TZ"'/' .env
else
  echo "TZ=$RESOLVED_TZ" >> .env
fi
```

(If `.env` doesn't exist, just `echo "TZ=$RESOLVED_TZ" > .env`.)

## 5. Credentials

Tool isolation runs in **docker mode** by default — each chat gets its own container. Build the tool image once before first run:

```bash
./container/build.sh
```

(Requires Docker Desktop on macOS/Windows or `docker` daemon on Linux.) If Docker isn't an option, set `"runtime": "sandbox-exec"` in `config/sandbox.default.json` to fall back to `sandbox-exec` (macOS) / `bubblewrap` (Linux) — bash-only isolation, no per-chat container.

The agent runs in-process via `@mariozechner/pi-coding-agent`; configure your provider via `.env` env vars or `~/.pi/agent/auth.json`.

AskUserQuestion: which provider?

1. **Anthropic (Claude)** — `ANTHROPIC_API_KEY` (or `ANTHROPIC_OAUTH_TOKEN`). console.anthropic.com.
2. **OpenAI** — `OPENAI_API_KEY`. platform.openai.com.
3. **Google (Gemini)** — `GEMINI_API_KEY`. aistudio.google.com.
4. **Other** — DeepSeek / Groq / xAI / Mistral / Cerebras / Bedrock / Azure, or `pi auth login` to populate `~/.pi/agent/auth.json` (no `.env` change needed).

Append the chosen key to `.env`:

```bash
echo 'ANTHROPIC_API_KEY=<key>' >> .env  # or OPENAI_API_KEY / GEMINI_API_KEY / DEEPSEEK_API_KEY ...
```

## 6. Channel: Feishu / Lark

This fork ships only the Feishu / Lark channel (`src/channels/feishu.ts`). Collect credentials and write them to `.env`:

1. Open the Feishu Developer Console (or Lark Open Platform): https://open.feishu.cn/app (国内) or https://open.larksuite.com/app (国际).
2. Create a self-build app, enable **Bot** capability, then enable **Events and Callbacks → Mode of event/callback subscription → Receive events through persistent connection**.
3. Add the `im:message` event subscription and `im.message.receive_v1` listener.
4. Copy **App ID** and **App Secret** from "Credentials & Basic Info".
5. Append to `.env` (ask the user for the values, then):

```bash
{
  echo "FEISHU_APP_ID=<app-id>"
  echo "FEISHU_APP_SECRET=<app-secret>"
  echo "FEISHU_DOMAIN=feishu"   # or "lark" for international Lark workspaces
} >> .env
```

6. Get the bot's `chat_id`: have a human invite the bot into the target chat, then send any message in that chat. After Step 8 starts the service, the chat_id will appear as `feishu:oc_xxxxxxxxxxxx` in `logs/nanoclaw.log` under `[feishu] inbound chat_id=...`. Register it as the main group via:

```bash
npx tsx setup/index.ts --step register -- \
  --jid 'feishu:oc_xxxxxxxxxxxx' \
  --name '<display name>' \
  --folder feishu_main \
  --is-main
```

7. **Install Feishu agent skills** (lark-cli + 20 skill bundles for calendar / im / doc / base / sheets / task / wiki / drive / mail / contact / vc / approval / etc):

```bash
# Skills (markdown — auto-discovered by ~/.agents/skills/)
npx skills add larksuite/cli -y -g

# CLI — already preinstalled in the docker tool image (container/Dockerfile).
# Verify the host install too if you ever want to invoke it manually:
which lark-cli || npm install -g @larksuite/cli
```

The first time the agent attempts a Feishu API operation it will run
`lark-cli auth login --recommend --no-wait`, post the verification URL into
the chat as a streaming card, and resume after the user clicks through. The
`FEISHU_APP_ID` / `FEISHU_APP_SECRET` from `.env` are auto-injected into
each container's lark-cli config on container create — no manual
`config init` needed.

Rebuild after `.env` changes:

```bash
npm run build
```

## 7. Mount Allowlist

AskUserQuestion: Allow agent access to external directories?

**No:**
```bash
mkdir -p ~/.config/nanoclaw
cat > ~/.config/nanoclaw/mount-allowlist.json <<'JSON'
{
  "allowedRoots": [],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
JSON
```

**Yes:** Collect paths and rw-flags from the user, then write the same file with the appropriate `allowedRoots` array. Example:

```bash
cat > ~/.config/nanoclaw/mount-allowlist.json <<'JSON'
{
  "allowedRoots": [
    {"path": "~/projects", "allowReadWrite": true, "description": "scratch"}
  ],
  "blockedPatterns": [".ssh", ".gnupg", ".aws"],
  "nonMainReadOnly": true
}
JSON
```

## 8. Service (this one stays scripted — plist/unit generation is non-trivial)

If a previous service is loaded, unload first:

- macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
- Linux (user): `systemctl --user stop nanoclaw`
- Linux (root): `systemctl stop nanoclaw`

Then:

```bash
npx tsx setup/index.ts --step service
```

Parse the status block.

- `FALLBACK=wsl_no_systemd` → WSL without systemd. Either enable systemd (`echo -e '[boot]\nsystemd=true' | sudo tee /etc/wsl.conf` + restart WSL) or use the generated `start-nanoclaw.sh` wrapper.
- `SERVICE_LOADED=false` → read `logs/setup.log`, then:
  - macOS: `launchctl list | grep nanoclaw`. If PID is `-` and status non-zero, read `logs/nanoclaw.error.log`.
  - Linux: `systemctl --user status nanoclaw` (or `systemctl status nanoclaw` if root).
  - Re-run the service step after fixing.

## 9. Verify (do it directly)

```bash
# Service status (pick one)
launchctl list | grep -E 'PID|com.nanoclaw' 2>/dev/null    # macOS
systemctl --user is-active nanoclaw 2>/dev/null             # Linux user
systemctl is-active nanoclaw 2>/dev/null                    # Linux root

# Credentials present?
grep -E '^(ANTHROPIC_API_KEY|ANTHROPIC_OAUTH_TOKEN|OPENAI_API_KEY|GEMINI_API_KEY|DEEPSEEK_API_KEY|GROQ_API_KEY|XAI_API_KEY|MISTRAL_API_KEY|CEREBRAS_API_KEY|AWS_BEARER_TOKEN_BEDROCK|AZURE_OPENAI_API_KEY)=' .env 2>/dev/null \
  || ls ~/.pi/agent/auth.json 2>/dev/null \
  || echo "NO CREDENTIALS"

# Channels configured?
grep -E '^(FEISHU_APP_ID|TELEGRAM_BOT_TOKEN|SLACK_BOT_TOKEN|DISCORD_BOT_TOKEN)=' .env

# Registered groups
node -e "const Database = require('better-sqlite3'); try { const db = new Database('store/messages.db',{readonly:true}); console.log('groups:', db.prepare('SELECT COUNT(*) AS c FROM registered_groups').get().c); } catch(e){ console.log('groups: 0'); }"

# Mount allowlist
ls ~/.config/nanoclaw/mount-allowlist.json 2>/dev/null && echo "allowlist:configured" || echo "allowlist:missing"
```

Decide what to fix:

- Service stopped → `npm run build`, then restart (`launchctl kickstart -k gui/$(id -u)/com.nanoclaw` / `systemctl --user restart nanoclaw` / re-run step 8 in WSL).
- No credentials → step 5.
- No channels in `.env` → step 6.
- 0 registered groups → in Feishu, send `@<bot>` in the chat you want to register; auto-registration kicks in on first inbound (see `src/index.ts:autoRegister`).
- No mount allowlist → step 7.

When everything's green, tell the user to send a message in their registered chat and offer `tail -f logs/nanoclaw.log` to watch.

## Troubleshooting

- **Service won't start** — `cat logs/nanoclaw.error.log`. Common: missing credentials, wrong Node path in plist, missing channel credentials. In docker mode also: Docker daemon not running (`docker info`) or image not built (`./container/build.sh`). In sandbox-exec mode: missing `ripgrep` (`brew install ripgrep` / `apt install ripgrep`).
- **Agent fails** — `tail logs/nanoclaw.log` for pi-coding-agent errors. Verify `.env` provider key. In docker mode: confirm `nanoclaw-tool:latest` exists (`docker image inspect nanoclaw-tool:latest`). In sandbox-exec mode: `sandbox-exec` (macOS) / `bwrap` (Linux) on PATH.
- **No reply** — trigger pattern? Main channel doesn't need a trigger; non-main groups need `@<ASSISTANT_NAME>` (default `@Andy`). Check `logs/nanoclaw.log`.
- **Channel disconnected** — credentials missing or invalid in `.env`. Restart the service after any `.env` change.
