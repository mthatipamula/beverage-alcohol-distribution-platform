#!/usr/bin/env bash
# End-to-end scenarios against a running stack: orders flow through Kafka to compliance and inventory.
#   ./scripts/smoke-test.sh                       local stack (http://localhost:8090, admin API key)
#   BASE_URL=https://... TOKEN=eyJ... ./scripts/smoke-test.sh    AWS (Cognito ID token of an admin user)
set -euo pipefail
cd "$(dirname "$0")"
exec python3 smoke_test.py
