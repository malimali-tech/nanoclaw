# NanoClaw Security Model

> **Note (2026-04):** Earlier versions ran agents in per-message Docker containers. NanoClaw now runs the agent in-process (`@mariozechner/pi-coding-agent`) and sandboxes only the **bash** tool at the OS level via `sandbox-exec` (macOS) / `bubblewrap` (Linux). This document reflects that model.

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Bash tool invocations | Sandboxed | OS-level network/filesystem ACL |
| Read/Write/Edit/Grep/Find/Ls tools | Host-level, mount-allowlist-gated | Path access controlled by `mount-allowlist.json` |
| Incoming messages | User input | Potential prompt injection |

## Security Boundaries

### 1. OS-level bash sandbox (primary boundary)

Bash commands the agent executes are wrapped by `@anthropic-ai/sandbox-runtime`:

- **macOS**: `sandbox-exec` profile generated from `config/sandbox.default.json`
- **Linux**: `bubblewrap` namespace + bind-mount profile

The profile declaratively constrains:

- **Network** — `network.allowedDomains` whitelist; everything else blocked
- **Filesystem reads** — `filesystem.denyRead` blocks `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh` by default
- **Filesystem writes** — `filesystem.allowWrite` defaults to the project root and `/tmp`; `filesystem.denyWrite` blocks `.env`, `*.pem`, `*.key`, `*.p12`

Per-group overrides live at `groups/<folder>/.pi/sandbox.json` and shallow-merge with the default profile. Set `enabled: false` to disable the sandbox (not recommended).

### 2. Mount allowlist

Read/Write/Edit/Grep/Find/Ls tools run in-process (no sandbox), but path access is gated by an **external allowlist** at `~/.config/nanoclaw/mount-allowlist.json`:

- Lives outside the project root, never visible to the agent
- Cannot be modified by agents
- Specifies which directories outside `groups/<folder>/` the agent may read or write

**Default blocked patterns** (always denied even if listed in `allowedRoots`):

```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**

- Symlink resolution before validation (prevents traversal attacks)
- `nonMainReadOnly` option forces read-only for non-main groups regardless of root config

### 3. Session isolation

Each group has its own working directory at `groups/<folder>/`:

- Per-group `CLAUDE.md` (memory)
- Per-group `.nanoclaw/log.jsonl` (message history)
- Per-group `.nanoclaw/cursor.json` (processing position)
- Per-group pi-coding-agent `SessionManager` state

Groups cannot see each other's `log.jsonl` or memory. Cross-group operations require explicit IPC tools (`schedule_task`, `register_group`) which check `isMain`.

### 4. IPC authorization

Tools registered by the nanoclaw extension verify the caller's group identity:

| Operation | Main group | Non-main group |
|-----------|------------|----------------|
| `send_message` to own chat | ✓ | ✓ |
| `schedule_task` for self | ✓ | ✓ |
| `schedule_task` for other group | ✓ (via `target_group_jid`) | ✗ |
| `list_tasks` (all) | ✓ | Own only |
| `register_group` | ✓ | ✗ |

## Privilege comparison

| Capability | Main group | Non-main group |
|------------|------------|----------------|
| Trigger word required | No | Yes (`@<ASSISTANT_NAME>`) |
| Working directory | `groups/main/` | `groups/<folder>/` |
| Additional mounts | Configurable via allowlist | Read-only unless allowlist explicitly allows |
| Schedule tasks for other groups | ✓ | ✗ |
| `/remote-control` command | ✓ | ✗ |

## Architecture diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Incoming messages (potentially malicious)                        │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼  Trigger check + sender allowlist
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Channel routing & message ingestion                            │
│  • Per-group cursor + log.jsonl                                   │
│  • IPC tool authorization                                         │
│  • Mount allowlist enforcement                                    │
│  • pi-coding-agent (in-process)                                   │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼  Bash invocations only
┌──────────────────────────────────────────────────────────────────┐
│              OS-LEVEL SANDBOX (sandbox-exec / bwrap)              │
│  • Network: allowedDomains whitelist                              │
│  • Filesystem: denyRead / allowWrite / denyWrite                  │
│  • Per-group override at groups/<folder>/.pi/sandbox.json         │
└──────────────────────────────────────────────────────────────────┘
```
