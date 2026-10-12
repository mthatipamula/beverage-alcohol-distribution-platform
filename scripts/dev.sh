#!/usr/bin/env bash
# Local stack with Docker Compose: Kafka, PostgreSQL, order-api, compliance-service, inventory-allocator
# and a gateway on http://localhost:8090 that routes like the AWS deployment.
#   ./scripts/dev.sh start [--ui]   build and start everything (--ui adds Kafka UI on :8095)
#   ./scripts/dev.sh stop           stop containers (data is kept)
#   ./scripts/dev.sh status         container health
#   ./scripts/dev.sh logs [service] follow logs
#   ./scripts/dev.sh reset          stop and delete all data (Postgres, Kafka, depletion feeds)
set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:-start}" in
  start)
    profile=()
    [ "${2:-}" = "--ui" ] && profile=(--profile ui)
    mkdir -p data/feeds
    docker compose "${profile[@]}" up -d --build
    printf 'Waiting for services'
    for _ in $(seq 1 120); do
      if curl -sf localhost:8090/health >/dev/null && curl -sf localhost:8091/health >/dev/null \
         && curl -sf -H 'X-API-Key: local-admin-key' 'localhost:8090/v1/inventory?state=FL' >/dev/null; then
        break
      fi
      printf '.'; sleep 2
    done
    echo
    docker compose ps --format 'table {{.Service}}\t{{.Status}}'
    cat <<MSG

API (gateway):     http://localhost:8090        OpenAPI: http://localhost:8090/docs
Compliance docs:   http://localhost:8091/docs
API keys:          local-admin-key | local-rep-key | local-retailer-key (account ACC-FL-1001)
Depletion feeds:   ./data/feeds
Try it:            ./scripts/smoke-test.sh
MSG
    if [ "${2:-}" = "--ui" ]; then echo "Kafka UI:          http://localhost:8095"; fi
    ;;
  stop)   docker compose --profile ui stop ;;
  status) docker compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}' ;;
  logs)   docker compose logs -f --tail 100 ${2:+"$2"} ;;
  reset)
    read -r -p "Delete all local data (orders, inventory, Kafka topics, feeds)? [y/N] " answer
    [ "$answer" = y ] || [ "$answer" = Y ] || { echo "Aborted."; exit 1; }
    docker compose --profile ui down -v
    rm -rf data/feeds
    echo "Deleted. Start fresh with ./scripts/dev.sh start"
    ;;
  *) echo "usage: $0 [start [--ui]|stop|status|logs [service]|reset]"; exit 1 ;;
esac
