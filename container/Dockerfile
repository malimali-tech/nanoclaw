# syntax=docker/dockerfile:1.7
# NanoClaw tool sandbox
#
# Per-chat container that hosts bash + scripting tools for the in-process
# pi-coding-agent. The LLM loop, credentials, and stateful extension tools
# stay on the host; only bash commands forward in via `docker exec`.
# Read/Write/Edit/Grep/Find/Ls remain on the host (against the bind mount)
# for binary & multimodal correctness — see src/agent/host-fs-tools.ts.
#
# Container lifecycle is per AgentSession (created on first prompt, removed
# on idle eviction). Bind mounts decided per chat by container-mounts.ts.
#
# Layer order: stable system deps → runtimes → frequently-bumped CLIs.
# Bumping agent-browser only invalidates the last layer.

FROM node:22-slim

# ---- Build-time arguments ----------------------------------------------------
# CJK fonts add ~200MB. Default ON for this fork (Feishu / Lark, mostly CN).
ARG INSTALL_CJK_FONTS=true
# agent-browser-stealth uses fork-style version tags (e.g. 0.24.0-fork.2) and
# publishes to npm under the `fork` dist-tag, not `latest`. Lock to a known
# good tag so rebuilds are reproducible — bump deliberately.
ARG AGENT_BROWSER_VERSION=0.24.0-fork.2
ARG UV_VERSION=latest

# ---- System dependencies -----------------------------------------------------
# Includes:
#   • Shell utilities the agent expects on $PATH (ripgrep is what pi's Grep
#     tool shells out to)
#   • Chromium + headless deps for agent-browser
#   • python3 + venv for skill-creator scripts and uv-managed environments
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        bash \
        coreutils \
        findutils \
        grep \
        sed \
        gawk \
        ripgrep \
        jq \
        curl \
        ca-certificates \
        git \
        less \
        procps \
        unzip \
        python3 \
        python3-venv \
        python3-pip \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        libgbm1 \
        libnss3 \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libasound2 \
        libpangocairo-1.0-0 \
        libcups2 \
        libdrm2 \
        libxshmfence1 \
        tini \
    && if [ "$INSTALL_CJK_FONTS" = "true" ]; then \
         apt-get install -y --no-install-recommends fonts-noto-cjk; \
       fi \
    && rm -rf /var/lib/apt/lists/*

# Make python3 the default `python` so skill scripts that shebang `python` work.
RUN ln -sf /usr/bin/python3 /usr/local/bin/python

# Chromium path for agent-browser / Playwright. Skip Playwright's own
# postinstall download — system chromium is what we use.
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ---- uv (Python package & venv manager) --------------------------------------
# Skill-creator and similar Python skills use uv to spin up isolated venvs
# without touching the system Python. Use the official installer; it's the
# only supported path that keeps the binary up to date with newer Python
# packaging features.
RUN curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh \
    && uv --version

# ---- agent-browser-stealth --------------------------------------------------
# Stealth fork of agent-browser (https://github.com/leeguooooo/agent-browser-stealth):
# ships the same `agent-browser` CLI plus 32 anti-detection JS patches and a
# CDP-native `Emulation.setAutomationOverride` toggle, applied automatically
# whenever the daemon launches its own Chromium (which is always the case in
# this container — there is no host Chrome to auto-connect to from inside the
# sandbox). This gives us bot-bypass for sannysoft / Cloudflare Turnstile-
# tier checks; deeper checks (full CF, Datadome) still require the user to
# export a logged-in cookie snapshot via `agent-browser state save` on the
# host and pass it in via `--state <path>`.
#
# pnpm via corepack to honor the stealth fork's postinstall (downloads the
# platform-specific Rust binary and patches the global bin shim). npm install
# -g would also work but pnpm caches better. The package exposes three bin
# aliases (`agent-browser-stealth`, `agent-browser`, `abs`); we use the
# `agent-browser` name throughout so existing skills and bash invocations
# need no changes.
#
# /usr/local/bin precedes /pnpm in PATH so our wrapper at
# /usr/local/bin/agent-browser shadows the pnpm shim and auto-injects
# --launch (see below). The unwrapped pnpm shims for `agent-browser-stealth`
# and `abs` remain reachable on /pnpm — useful as an escape hatch.
ENV PNPM_HOME="/pnpm"
ENV PATH="/usr/local/bin:$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@latest --activate

RUN --mount=type=cache,target=/root/.cache/pnpm \
    echo "only-built-dependencies[]=agent-browser-stealth" > /root/.npmrc && \
    pnpm install -g "agent-browser-stealth@${AGENT_BROWSER_VERSION}" && \
    /pnpm/agent-browser --version

# Wrapper: this container has no host Chrome reachable via CDP, so the daemon
# must always launch its own Chromium (which is also what activates the
# 32-patch stealth suite + setAutomationOverride). The stealth fork tries
# auto-connect first by default and aborts when no host Chrome is found, so
# we inject `--launch` here. AGENT_BROWSER_FORCE_LAUNCH env exists in the
# source but does not reliably take effect in 0.24.0-fork.2, hence the
# wrapper.
#
# Pass-through behavior: if the agent explicitly invokes the `connect`
# subcommand or passes `--cdp <target>` (e.g. when a future setup forwards
# a host-reachable remote CDP), we don't inject --launch — the agent's
# explicit intent wins. This matches CLI semantics where --cdp would
# otherwise conflict with --launch.
RUN cat > /usr/local/bin/agent-browser <<'WRAPPER' && chmod +x /usr/local/bin/agent-browser
#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    connect|--cdp) exec /pnpm/agent-browser "$@" ;;
  esac
done
exec /pnpm/agent-browser --launch "$@"
WRAPPER

# ---- lark-cli (Feishu / Lark official CLI) -----------------------------------
# Provides the `lark-cli` binary the agent shells out to for any Feishu API
# operation (calendar, im, doc, base, sheets, task, wiki, drive, mail, ...).
# Skill markdown lives on the host in ~/.agents/skills/ (installed via
# `npx skills add larksuite/cli -y -g`) and is bind-mounted in by
# container-mounts.ts at the same path, so the agent reads them where pi
# advertised.
#
# The lark-cli npm package's postinstall pulls the platform-appropriate Go
# binary, so installing it once at image build time avoids paying that on
# every container create.
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g @larksuite/cli && \
    lark-cli --version

# Redirect lark-cli config + secret storage onto the bind-mounted volumes
# from container-mounts.ts so token state survives container restarts and
# is shared across per-chat containers (see CONTAINER_PATHS.larkCliState).
ENV LARKSUITE_CLI_CONFIG_DIR=/workspace/lark-cli/config
ENV LARKSUITE_CLI_DATA_DIR=/workspace/lark-cli/data

# ---- Workspace + permissions -------------------------------------------------
# Standard mount targets. /workspace/group is the per-chat working dir;
# /workspace/global is shared memory; /workspace/project is main-only RO.
# container-mounts.ts decides which of these get bind-mounted for a chat.
#
# `node:22-slim` ships with a `node` user at UID 1000 — reuse it instead
# of creating a duplicate. Matches the host uid that container-pool.ts
# passes via `--user $UID:$GID` so bind-mounted writes land owned by the
# host user, not root.
RUN mkdir -p /workspace/group /workspace/global /workspace/project \
                /workspace/lark-cli/config /workspace/lark-cli/data \
    && chown -R node:node /workspace /pnpm \
    && chmod 777 /home/node

USER node
WORKDIR /workspace/group

# tini reaps zombies and forwards signals cleanly so `docker stop -t 1`
# actually shuts the container's bash subprocess down instead of leaking it.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
