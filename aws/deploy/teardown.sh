#!/usr/bin/env bash
# Deletes everything the deploy scripts created: services, infrastructure (RDS, MSK, ...), feeds and images.
source "$(dirname "$0")/common.sh"
echo "Account $ACCOUNT_ID ($AWS_PROFILE), region $AWS_REGION"
read -r -p "Delete the whole $PROJECT deployment, including the database? Type the project name ($PROJECT): " answer
[ "$answer" = "$PROJECT" ] || { echo "Aborted."; exit 1; }

log "Deleting $SERVICES_STACK"
aws cloudformation delete-stack --stack-name "$SERVICES_STACK"
aws cloudformation wait stack-delete-complete --stack-name "$SERVICES_STACK"

BUCKET=$(stack_output "$INFRA_STACK" FeedsBucket 2>/dev/null || true)
if [ -n "$BUCKET" ] && [ "$BUCKET" != "None" ]; then
  log "Emptying s3://$BUCKET"
  aws s3 rm "s3://$BUCKET" --recursive >/dev/null || true
fi
log "Deleting $INFRA_STACK (MSK takes 10-20 minutes)"
aws cloudformation delete-stack --stack-name "$INFRA_STACK"
aws cloudformation wait stack-delete-complete --stack-name "$INFRA_STACK"

log "Deleting ECR repositories"
for svc in $SERVICES; do aws ecr delete-repository --repository-name "$PROJECT/$svc" --force >/dev/null 2>&1 || true; done
rm -f "$OUTPUTS_FILE"
echo "Done."
