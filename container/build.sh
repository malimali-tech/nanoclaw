#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Vendor @codeany/open-agent-sdk into the build context so the container
# can install it via the file: dependency in agent-runner/package.json.
# Default path: sibling of the nanoclaw repo.
OPEN_AGENT_SDK_PATH="${OPEN_AGENT_SDK_PATH:-$(cd "$SCRIPT_DIR/../.." && pwd)/open-agent-sdk-typescript}"
VENDOR_DIR="$SCRIPT_DIR/agent-runner/vendor/open-agent-sdk"

if [ ! -d "$OPEN_AGENT_SDK_PATH" ]; then
  echo "ERROR: open-agent-sdk-typescript not found at $OPEN_AGENT_SDK_PATH"
  echo "Set OPEN_AGENT_SDK_PATH to override."
  exit 1
fi

echo "Vendoring @codeany/open-agent-sdk from $OPEN_AGENT_SDK_PATH"
if [ ! -d "$OPEN_AGENT_SDK_PATH/dist" ]; then
  echo "  Building SDK (no dist/ found)..."
  ( cd "$OPEN_AGENT_SDK_PATH" && npm install --no-audit --no-fund && npm run build )
fi

mkdir -p "$VENDOR_DIR"
rsync -a --delete \
  --exclude=node_modules \
  --exclude=.git \
  --exclude=examples \
  "$OPEN_AGENT_SDK_PATH/" "$VENDOR_DIR/"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
