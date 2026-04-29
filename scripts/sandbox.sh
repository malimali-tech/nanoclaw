#!/usr/bin/env bash
#
# NanoClaw Docker sandbox container manager.
#
# Manages a single long-running Docker container shared across all groups.
# NanoClaw never `docker run`s the container itself; the user does, via this
# script. NanoClaw only health-checks the container at runtime.
#
# Usage:
#   scripts/sandbox.sh create [--image <img>]
#   scripts/sandbox.sh start
#   scripts/sandbox.sh stop
#   scripts/sandbox.sh remove
#   scripts/sandbox.sh status   # exit 0=running, 1=stopped, 2=missing
#   scripts/sandbox.sh shell

set -euo pipefail

NAME="${NANOCLAW_SANDBOX_NAME:-nanoclaw-sandbox}"
IMAGE="${NANOCLAW_SANDBOX_IMAGE:-debian:12-slim}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<EOF
NanoClaw Docker Sandbox Manager

Usage: $0 <command> [args]

Commands:
  create [--image <img>]   Create and start the sandbox container
  start                    Start an existing (stopped) container
  stop                     Stop the container
  remove                   Force-remove the container
  status                   Print running|stopped|missing (exit 0|1|2)
  shell                    Open an interactive bash shell in the container

Environment:
  NANOCLAW_SANDBOX_NAME    Container name (default: nanoclaw-sandbox)
  NANOCLAW_SANDBOX_IMAGE   Image (default: debian:12-slim)
EOF
}

# Returns 0 if a container with $NAME exists (running or stopped).
container_exists() {
  local out
  out="$(docker ps -a --format '{{.Names}}' || true)"
  printf '%s\n' "$out" | grep -qx "$NAME"
}

# Returns 0 if a container with $NAME is currently running.
container_running() {
  local out
  out="$(docker ps --format '{{.Names}}' || true)"
  printf '%s\n' "$out" | grep -qx "$NAME"
}

cmd_create() {
  # Optional --image override for this single invocation.
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --image)
        if [ "$#" -lt 2 ]; then
          echo "create: --image requires an argument" >&2
          exit 64
        fi
        IMAGE="$2"
        shift 2
        ;;
      *)
        echo "create: unknown argument: $1" >&2
        exit 64
        ;;
    esac
  done

  if container_exists; then
    echo "Container '$NAME' already exists. Remove it first with: $0 remove" >&2
    exit 1
  fi

  # Ensure store/groups exist on the host (Docker would create them as root
  # otherwise, which causes permission surprises later).
  mkdir -p "$REPO/store" "$REPO/groups"

  # An empty file used to shadow the host's .env inside the container. Tmpfs
  # cannot mount over a file (only over a directory), so we bind-mount this
  # zero-byte file read-only over /workspace/project/.env. This prevents the
  # sandboxed agent from reading host LLM credentials.
  local env_shadow="$REPO/store/.sandbox-empty-env"
  : > "$env_shadow"

  docker run -d \
    --name "$NAME" \
    --mount "type=bind,source=$REPO,destination=/workspace/project,readonly" \
    --mount "type=bind,source=$env_shadow,destination=/workspace/project/.env,readonly" \
    --mount "type=bind,source=$REPO/store,destination=/workspace/store" \
    --mount "type=bind,source=$REPO/groups,destination=/workspace/groups" \
    "$IMAGE" \
    sleep infinity >/dev/null

  echo "Created $NAME"
}

cmd_start() {
  docker start "$NAME" >/dev/null
  echo "Started $NAME"
}

cmd_stop() {
  docker stop "$NAME" >/dev/null
  echo "Stopped $NAME"
}

cmd_remove() {
  docker rm -f "$NAME" >/dev/null
  echo "Removed $NAME"
}

cmd_status() {
  if container_running; then
    echo "running"
    exit 0
  elif container_exists; then
    echo "stopped"
    exit 1
  else
    echo "missing"
    exit 2
  fi
}

cmd_shell() {
  exec docker exec -it "$NAME" /bin/bash
}

if [ "$#" -lt 1 ]; then
  usage >&2
  exit 64
fi

sub="$1"
shift

case "$sub" in
  create) cmd_create "$@" ;;
  start)
    if [ "$#" -gt 0 ]; then
      echo "start: takes no arguments" >&2
      exit 64
    fi
    cmd_start
    ;;
  stop)
    if [ "$#" -gt 0 ]; then
      echo "stop: takes no arguments" >&2
      exit 64
    fi
    cmd_stop
    ;;
  remove)
    if [ "$#" -gt 0 ]; then
      echo "remove: takes no arguments" >&2
      exit 64
    fi
    cmd_remove
    ;;
  status)
    if [ "$#" -gt 0 ]; then
      echo "status: takes no arguments" >&2
      exit 64
    fi
    cmd_status
    ;;
  shell)
    if [ "$#" -gt 0 ]; then
      echo "shell: takes no arguments" >&2
      exit 64
    fi
    cmd_shell
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 64
    ;;
esac
