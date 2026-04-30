# NanoClaw tool sandbox
#
# Minimal long-running container that hosts bash for the in-process
# pi-coding-agent. The LLM loop runs on the host (with credentials);
# only bash commands are forwarded here via `docker exec`. Read/Write/Edit
# remain on the host (against the bind-mounted group folder) for binary &
# multimodal correctness — see src/agent/host-fs-tools.ts for how that
# stays in scope.
#
# Per-chat container; lifecycle aligned with AgentSession (created on
# first prompt, killed on idle eviction). Mount set computed per-chat by
# src/agent/container-mounts.ts.

FROM debian:12-slim

# Tools the agent typically reaches for. ripgrep is what pi's Grep tool
# shells out to. jq/curl/git are the minimum that lets self-bootstrap
# work without immediate `apt-get install` from the agent.
RUN apt-get update && apt-get install -y --no-install-recommends \
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
    && rm -rf /var/lib/apt/lists/*

# Standard mount targets. /workspace/group is the per-chat working dir;
# /workspace/global is shared memory; /workspace/project is main-only and
# read-only. container-mounts.ts decides which of these get bind-mounted
# for a given chat.
RUN mkdir -p /workspace/group /workspace/global /workspace/project

# Run as non-root so bind-mounted files don't end up root-owned on the
# host. UID/GID are overridden at `docker run` time to match the host
# user — see container-runtime.ts:dockerRunArgs.
RUN useradd -m -u 1000 -s /bin/bash agent
USER agent
WORKDIR /workspace/group

# Container is a long-running shell holder; tool calls arrive via
# `docker exec`. `sleep infinity` keeps PID 1 alive without polling.
CMD ["sleep", "infinity"]
