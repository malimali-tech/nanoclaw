#!/usr/bin/env bash
# Build the NanoClaw tool sandbox image.
#
# Usage:
#   ./container/build.sh            # builds nanoclaw-tool:latest
#   ./container/build.sh v2         # builds nanoclaw-tool:v2

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG="${1:-latest}"
IMAGE="nanoclaw-tool:${TAG}"

cd "$SCRIPT_DIR"

echo "Building ${IMAGE}..."
docker build -t "$IMAGE" .

echo
echo "Built ${IMAGE}. Verify with:"
echo "  docker run --rm ${IMAGE} bash -c 'rg --version | head -1; python3 --version; uv --version; agent-browser --version'"
