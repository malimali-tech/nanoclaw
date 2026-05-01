# NanoClaw Documentation

The official documentation is at **[docs.nanoclaw.dev](https://docs.nanoclaw.dev)**.

The files in this directory are original design documents and developer references. For the most current and accurate information, use the documentation site.

| This directory | Documentation site |
|---|---|
| [REQUIREMENTS.md](REQUIREMENTS.md) | [Introduction](https://docs.nanoclaw.dev/introduction) |
| [SECURITY.md](SECURITY.md) | [Security model](https://docs.nanoclaw.dev/concepts/security) |

Historical design plans live under `docs/plans/`.

Several upstream-only docs were removed from this fork because they describe mechanisms that don't apply here:
- `skills-as-branches.md` (upstream skill = branch system; this fork uses bundled `.claude/skills/` + global `~/.agents/skills/`)
- `BRANCH-FORK-MAINTENANCE.md` (channel-fork merge model; this fork doesn't pull from upstream)
- `SPEC.md`, `SDK_DEEP_DIVE.md`, `docker-sandboxes.md`, `DEBUG_CHECKLIST.md`, `APPLE-CONTAINER-NETWORKING.md` (pre-pi-mono container architecture)

See `git log` if you need the history.
