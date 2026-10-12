#!/usr/bin/env bash
# Builds the three images for ARM64 (Graviton Fargate) and pushes them to ECR with a new tag.
source "$(dirname "$0")/common.sh"
confirm_account "Push images"
TAG=${IMAGE_TAG:-$(date +%Y%m%d-%H%M%S)-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo local)}
aws ecr get-login-password | docker login --username AWS --password-stdin "${REGISTRY%%/*}" >/dev/null
for svc in $SERVICES; do
  log "Building $svc:$TAG"
  docker buildx build --platform linux/arm64 -t "$REGISTRY/$svc:$TAG" --push "$ROOT/services/$svc"
done
echo "IMAGE_TAG=$TAG" > "$OUTPUTS_FILE"
log "Pushed tag $TAG. Next: ./aws/deploy/03-deploy.sh"
