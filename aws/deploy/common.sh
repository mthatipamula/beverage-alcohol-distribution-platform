# Shared helpers for the AWS deploy scripts.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=config.env
source "$HERE/config.env"
export AWS_PROFILE AWS_REGION AWS_PAGER=""
# Credentials exported in the shell would override the profile, so they are ignored here.
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_DEFAULT_PROFILE

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

if ! aws configure list-profiles 2>/dev/null | grep -qx "$AWS_PROFILE"; then
  cat >&2 <<MSG
AWS CLI profile "$AWS_PROFILE" does not exist. Create the beverage-distributor AWS account and an
administrator user (or IAM Identity Center access) for it, then configure the profile:
  aws configure --profile $AWS_PROFILE          # access key, or:
  aws configure sso --profile $AWS_PROFILE      # IAM Identity Center
See the README section "Deploy to AWS".
MSG
  exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
CALLER=$(aws sts get-caller-identity --query Arn --output text)
if [ -n "$EXPECTED_ACCOUNT_ID" ] && [ "$ACCOUNT_ID" != "$EXPECTED_ACCOUNT_ID" ]; then
  echo "Profile $AWS_PROFILE points at account $ACCOUNT_ID, but EXPECTED_ACCOUNT_ID is $EXPECTED_ACCOUNT_ID. Stopping." >&2
  exit 1
fi
for forbidden in $FORBIDDEN_ACCOUNT_IDS; do
  if [ "$ACCOUNT_ID" = "$forbidden" ]; then
    echo "Profile $AWS_PROFILE points at account $ACCOUNT_ID, which is not the beverage-distributor account. Stopping." >&2
    exit 1
  fi
done
REGISTRY="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$PROJECT"
OUTPUTS_FILE="$HERE/.outputs.env"

# Asks before anything that creates, changes or deletes resources (set CONFIRM=yes to skip).
confirm_account() {
  echo "AWS account: $ACCOUNT_ID   region: $AWS_REGION   profile: $AWS_PROFILE"
  echo "Signed in as: $CALLER"
  [ "${CONFIRM:-}" = yes ] && return 0
  read -r -p "$1 in this account? [y/N] " answer
  [ "$answer" = y ] || [ "$answer" = Y ] || { echo "Aborted."; exit 1; }
}

stack_output() {
  aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}
