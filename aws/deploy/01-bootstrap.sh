#!/usr/bin/env bash
# One-time: ECR repositories for the four images (three services and the web app) (scan on push, keep the last 10 images).
source "$(dirname "$0")/common.sh"
confirm_account "Create ECR repositories"
for svc in $SERVICES; do
  repo="$PROJECT/$svc"
  if aws ecr describe-repositories --repository-names "$repo" >/dev/null 2>&1; then
    echo "exists: $repo"
  else
    aws ecr create-repository --repository-name "$repo" --image-scanning-configuration scanOnPush=true \
      --encryption-configuration encryptionType=AES256 >/dev/null
    echo "created: $repo"
  fi
  aws ecr put-lifecycle-policy --repository-name "$repo" --lifecycle-policy-text \
    '{"rules":[{"rulePriority":1,"description":"keep last 10","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":10},"action":{"type":"expire"}}]}' >/dev/null
done
log "Next: ./aws/deploy/02-build-push.sh"
