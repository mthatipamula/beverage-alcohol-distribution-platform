#!/usr/bin/env bash
# Deploys the infrastructure stack (first run ~30 minutes, mostly MSK) and then the services stack.
source "$(dirname "$0")/common.sh"
[ -f "$OUTPUTS_FILE" ] && source "$OUTPUTS_FILE"
: "${IMAGE_TAG:?No image tag. Run ./aws/deploy/02-build-push.sh first}"
confirm_account "Deploy stacks $INFRA_STACK and $SERVICES_STACK (image $IMAGE_TAG; billable resources)"

log "Infrastructure stack $INFRA_STACK (VPC, RDS, MSK, Cognito, ALB, API Gateway)"
aws cloudformation deploy --stack-name "$INFRA_STACK" --template-file "$HERE/cloudformation/infra.yaml" \
  --parameter-overrides ProjectName="$PROJECT" --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset

CLUSTER_ARN=$(stack_output "$INFRA_STACK" KafkaClusterArn)
BROKERS=$(aws kafka get-bootstrap-brokers --cluster-arn "$CLUSTER_ARN" --query BootstrapBrokerStringSaslScram --output text)

log "Services stack $SERVICES_STACK"
aws cloudformation deploy --stack-name "$SERVICES_STACK" --template-file "$HERE/cloudformation/services.yaml" \
  --parameter-overrides InfraStackName="$INFRA_STACK" ImageRegistry="$REGISTRY" ImageTag="$IMAGE_TAG" \
    KafkaBootstrapBrokers="$BROKERS" SeedDemoData="$SEED_DEMO_DATA" \
  --no-fail-on-empty-changeset

API_URL=$(stack_output "$INFRA_STACK" ApiUrl)
log "Deployed: $API_URL"
cat <<MSG
  Web app:      $API_URL   (sign in with a Cognito user; create one below)
  Health:       curl $API_URL/health
  Create users: ./aws/deploy/create-user.sh you@example.com admin
  Smoke test:   BASE_URL=$API_URL TOKEN=\$(./aws/deploy/get-token.sh you@example.com) ./scripts/smoke-test.sh
  Status:       ./aws/deploy/status.sh
MSG
