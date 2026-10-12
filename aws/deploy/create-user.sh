#!/usr/bin/env bash
# Creates a Cognito user in a group. Retail users also need the account they buy for.
#   ./aws/deploy/create-user.sh ops@example.com admin
#   ./aws/deploy/create-user.sh rep@example.com sales_rep
#   ./aws/deploy/create-user.sh buyer@example.com retailer ACC-FL-1001
source "$(dirname "$0")/common.sh"
EMAIL=${1:?usage: create-user.sh EMAIL admin|sales_rep|retailer [ACCOUNT_ID]}
GROUP=${2:?usage: create-user.sh EMAIL admin|sales_rep|retailer [ACCOUNT_ID]}
case "$GROUP" in admin|sales_rep) ;; retailer) : "${3:?retail users need an ACCOUNT_ID}" ;; *) echo "unknown group $GROUP"; exit 1 ;; esac
POOL=$(stack_output "$INFRA_STACK" UserPoolId)
confirm_account "Create user $EMAIL ($GROUP)"

attrs=(Name=email,Value="$EMAIL" Name=email_verified,Value=true)
[ -n "${3:-}" ] && attrs+=(Name=custom:account_id,Value="$3")
aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$EMAIL" --message-action SUPPRESS \
  --user-attributes "${attrs[@]}" >/dev/null
read -r -s -p "Password for $EMAIL (12+ chars, upper, lower, number): " PASSWORD; echo
aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username "$EMAIL" --password "$PASSWORD" --permanent
aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL" --username "$EMAIL" --group-name "$GROUP"
echo "Created $EMAIL in $GROUP. Get a token with ./aws/deploy/get-token.sh $EMAIL"
