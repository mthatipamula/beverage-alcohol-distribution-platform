#!/usr/bin/env bash
# Signs in and prints a Cognito ID token (valid 60 minutes) for API calls:
#   TOKEN=$(./aws/deploy/get-token.sh ops@example.com)
#   curl -H "Authorization: Bearer $TOKEN" "$API_URL/v1/accounts"
source "$(dirname "$0")/common.sh" >/dev/null
EMAIL=${1:?usage: get-token.sh EMAIL}
CLIENT=$(stack_output "$INFRA_STACK" UserPoolClientId)
read -r -s -p "Password for $EMAIL: " PASSWORD </dev/tty; echo >&2
aws cognito-idp initiate-auth --client-id "$CLIENT" --auth-flow USER_PASSWORD_AUTH \
  --auth-parameters USERNAME="$EMAIL",PASSWORD="$PASSWORD" --query AuthenticationResult.IdToken --output text
