#!/bin/sh
# Writes the runtime config read by the browser (no secrets: the Cognito app client is public).
set -e
cat > /usr/share/nginx/html/config.json <<JSON
{
  "authMode": "${AUTH_MODE:-api-key}",
  "brandName": "${BRAND_NAME:-BevDist Wholesale}",
  "cognitoRegion": "${COGNITO_REGION:-}",
  "cognitoClientId": "${COGNITO_CLIENT_ID:-}"
}
JSON
exec nginx -g 'daemon off;'
