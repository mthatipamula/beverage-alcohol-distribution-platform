#!/usr/bin/env bash
# Stack status, ECS services and API health.
source "$(dirname "$0")/common.sh"
echo "Account $ACCOUNT_ID ($AWS_PROFILE), region $AWS_REGION"
for s in "$INFRA_STACK" "$SERVICES_STACK"; do
  printf '%-18s %s\n' "$s" "$(aws cloudformation describe-stacks --stack-name "$s" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo 'not deployed')"
done
if aws ecs describe-clusters --clusters "$PROJECT" --query 'clusters[0].status' --output text 2>/dev/null | grep -q ACTIVE; then
  aws ecs describe-services --cluster "$PROJECT" --services $SERVICES \
    --query 'services[].[serviceName,status,runningCount,desiredCount]' --output table 2>/dev/null || true
fi
API_URL=$(stack_output "$INFRA_STACK" ApiUrl 2>/dev/null || true)
[ -n "$API_URL" ] && echo "API $API_URL  health: $(curl -s -m 10 "$API_URL/health" || echo unreachable)"
