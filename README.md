# Beverage Alcohol Distribution Platform

An event-driven B2B ordering and compliance platform for a **three-tier beverage alcohol distributor**.
Licensed retail accounts and sales reps place orders through a REST API. Each order is then checked against
**state alcohol rules**, **inventory is reserved** from in-state warehouses, and confirmed sales are reported
back to suppliers as **depletion feeds**. Services communicate asynchronously over **Apache Kafka**.

| Service | Language | Role |
|---|---|---|
| [`order-api`](services/order-api) | Node.js 22, TypeScript, Fastify | REST API for accounts, catalog and orders; transactional outbox to Kafka; tracks order status from events |
| [`compliance-service`](services/compliance-service) | Python 3.12, FastAPI | State compliance checks (licenses, credit law, price posting, delivery days); supplier depletion feeds |
| [`inventory-allocator`](services/inventory-allocator) | Rust (tokio, rdkafka) | Reserves stock across in-state warehouses; idempotent, with retries and a dead-letter topic |

**Infrastructure:** Apache Kafka (Amazon MSK), PostgreSQL (Amazon RDS), ECS Fargate (ARM64), API Gateway,
Cognito, S3, CloudFormation. Locally, everything runs in Docker Compose.

> Demo data (accounts, brands, suppliers, licenses) is fictional, and the state rules are **illustrative,
> not legal advice**. Real rules differ by state and change over time.

## The business in brief

US alcohol sales follow the **three-tier system**: suppliers (wineries, distilleries, brewers) sell to
distributors, and distributors sell to licensed retailers. Retailers are either **off-premise** (liquor and
grocery stores) or **on-premise** (bars, restaurants, hotels). Every state regulates the distributor-to-retailer
sale differently:

| Rule | What the platform checks |
|---|---|
| **Retail license** | The account has an active license in the order's state that covers the product category (beer only, beer and wine, or full liquor), and it doesn't expire before delivery |
| **Credit law** | In credit-law states, a delinquent account may only buy cash on delivery (COD) |
| **Price posting** | In price-posting states, every line must be sold at the price filed with the state, so no ad hoc discounts |
| **Delivery days** | Some states don't allow Sunday (or Saturday) deliveries |
| **In-state inventory** | Stock ships only from licensed warehouses in the retailer's state |
| **Depletions** | Distributors report sales by account and SKU back to each supplier |

## Architecture

```
 Retailers / sales reps
        │  HTTPS + Cognito token (AWS) or X-API-Key (local)
        ▼
 API Gateway (JWT check) ── VPC link ──▶ internal ALB  (locally: nginx on :8090)
        │  /v1/orders, /v1/accounts, /v1/products        /v1/compliance/*, /v1/depletions/*     /v1/inventory
        ▼                                                 ▼                                      ▼
   order-api (Node.js)                              compliance-service (Python)          inventory-allocator (Rust)
        │ order + outbox row in one transaction            │                                      │
        ▼                                                  │                                      │
 ┌───────────────────────────────── Kafka (Amazon MSK) ────────────────────────────────────────────────┐
 │ orders.placed ──▶ compliance ──▶ orders.validated ──▶ allocator ──▶ inventory.reserved               │
 │                              └─▶ orders.rejected                 └─▶ inventory.failed               │
 │ order-api consumes validated / rejected / reserved / failed ──▶ orders.confirmed ──▶ depletion feeds │
 │ dead-letter topics: order-api.dlq, compliance-service.dlq, inventory-allocator.dlq                    │
 └──────────────────────────────────────────────────────────────────────────────────────────────────────┘
        │
 PostgreSQL (one schema per service: orders, compliance, inventory)      S3: depletions/{supplier}/{date}.csv
```

**Order lifecycle:** `PENDING_COMPLIANCE` → `PENDING_INVENTORY` → `CONFIRMED`, or `REJECTED` (with the rules
that failed) or `BACKORDERED` (with the shortage). `POST /v1/orders` returns **202 Accepted** at once, and the
client polls `GET /v1/orders/{id}`.

### Reliability patterns

| Problem | How it's handled |
|---|---|
| Client retries a POST | **Idempotency-Key** header (required). Same key and body returns the original order (200). Same key with a different body returns 422 |
| Order saved but event lost, or event sent but order not saved | **Transactional outbox**: the order and its event are written in one database transaction, and a relay publishes outbox rows (`FOR UPDATE SKIP LOCKED`, so several instances can relay) |
| Kafka delivers a message twice | Every consumer is **idempotent**: order-api records processed event IDs; compliance and inventory store their decision per order and re-send the *same* event (deterministic UUIDv5 event ID) on redelivery |
| Events from different topics arrive out of order | Order status only moves forward (a late `OrderValidated` after `CONFIRMED` is ignored) |
| Two orders compete for the last cases | Stock rows are locked with `SELECT … FOR UPDATE` in a fixed order (no deadlocks), and allocation is all-or-nothing |
| A malformed or repeatedly failing message | Retried with backoff, then sent to the service's **dead-letter topic** with the error, so the partition keeps moving |
| Ordering per order | Every message is keyed by order ID, so one order's events stay in order on one partition |

## Run locally

Prerequisites: Docker Desktop (Rust, Python and Node run inside containers). Python 3 is needed for the smoke test.

Build and start Kafka, Postgres, the three services and the gateway (the first build takes a few minutes, mostly Rust):

```bash
./scripts/dev.sh start
```

Run 14 end-to-end scenarios:

```bash
./scripts/smoke-test.sh
```

| What | Where |
|---|---|
| API (gateway, same routes as AWS) | http://localhost:8090 |
| Order API docs (OpenAPI) | http://localhost:8090/docs |
| Compliance service docs | http://localhost:8091/docs |
| Kafka UI (`./scripts/dev.sh start --ui`) | http://localhost:8095 |
| Supplier depletion feeds | `./data/feeds/depletions/` |

**API keys:**
- `local-admin-key`
- `local-rep-key` (sales rep, may apply discounts)
- `local-retailer-key` (retail user for account `ACC-FL-1001` only)

**Other commands:** `./scripts/dev.sh status`, `./scripts/dev.sh logs order-api`, `./scripts/dev.sh stop`, and
`./scripts/dev.sh reset` (deletes all local data).

### Try it

Place an order:

```bash
curl -s -X POST localhost:8090/v1/orders -H 'X-API-Key: local-rep-key' -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  -d '{"accountId":"ACC-NY-3001","deliveryDate":"2026-10-14","paymentTerms":"NET","lines":[{"sku":"SKU-SP-1001","quantityCases":4,"discountPct":10}]}'
```

Check its status (here, `REJECTED` with `PRICE_POSTING_VIOLATION`: New York is a price-posting state):

```bash
curl -s localhost:8090/v1/orders/<id> -H 'X-API-Key: local-rep-key'
```

Check what rules a draft order would break, without placing it:

```bash
curl -s -X POST localhost:8090/v1/compliance/check -H 'X-API-Key: local-rep-key' -H 'Content-Type: application/json' \
  -d '{"accountId":"ACC-TX-2001","state":"TX","paymentTerms":"NET","deliveryDate":"2026-10-14","lines":[{"sku":"SKU-SP-1002","category":"SPIRITS","quantityCases":3,"unitPriceCents":28224}]}'
```

**Demo accounts:**

| Account | State | License | Notes |
|---|---|---|---|
| ACC-FL-1001 Bayside Liquors | FL | Full liquor | Normal |
| ACC-FL-1002 Ocean Grill | FL | Beer and wine | Can't buy spirits |
| ACC-TX-2001 Lone Star Spirits | TX | Full liquor | **Delinquent**: COD only |
| ACC-TX-2002 Austin Taproom | TX | Beer only | |
| ACC-NY-3001 Hudson Wine & Spirits | NY | Full liquor | Price-posting state |
| ACC-CA-4001 Sunset Bistro | CA | Beer and wine | **Suspended** |
| ACC-GA-5001 Peach State Package Store | GA | Full liquor | License **expires in 3 days** |

### Tests

| Service | Run from the service folder | What it covers |
|---|---|---|
| order-api | `npm install && npm test` | Pricing, idempotency hash, business dates |
| compliance-service | `python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/pytest` | Every state rule |
| inventory-allocator | `docker build .` (runs `cargo test`) | Allocation: priority order, splits, shortages, shared SKUs |

## Deploy to AWS

All deployment scripts are in [`aws/deploy`](aws/deploy) and use **CloudFormation**:

| Stack | Template | Contents |
|---|---|---|
| `bevdist-infra` | [`infra.yaml`](aws/deploy/cloudformation/infra.yaml) | VPC (2 AZs, no NAT gateway), RDS PostgreSQL, Amazon MSK (2 brokers, SASL/SCRAM over TLS), Cognito user pool and groups, ECS cluster, internal ALB, API Gateway HTTP API with JWT authorizer and VPC link, S3 feeds bucket, IAM roles |
| `bevdist-services` | [`services.yaml`](aws/deploy/cloudformation/services.yaml) | Four ECS Fargate services on ARM64 (Graviton): the three backends and the web app (nginx), with target groups, routing rules and CloudWatch log groups |

Secrets never appear in templates or scripts: the database password is generated and managed by RDS in
Secrets Manager, the Kafka SCRAM credentials are generated into a KMS-encrypted secret, and ECS injects both
into the containers.

### 1. Set up the AWS account and CLI profile (once)

The scripts only ever use the AWS CLI profile **`beverage-alcohol-distributor`**. They stop if it's missing, if it
points at another account, or if `EXPECTED_ACCOUNT_ID` is set and doesn't match.

1. Create a dedicated AWS account for this project, and turn on MFA for its root user.
2. In that account, create an administrator user. IAM Identity Center is recommended; an IAM user with
   access keys also works.
3. Configure the profile. With IAM Identity Center:

   ```bash
   aws configure sso --profile beverage-alcohol-distributor
   ```

   With an access key instead:

   ```bash
   aws configure --profile beverage-alcohol-distributor
   ```

4. Put the account ID in `EXPECTED_ACCOUNT_ID` in [`aws/deploy/config.env`](aws/deploy/config.env).

### 2. Deploy

Every script shows the account and asks before changing anything.

```bash
./aws/deploy/01-bootstrap.sh     # ECR repositories (once)
./aws/deploy/02-build-push.sh    # build the four ARM64 images and push them
./aws/deploy/03-deploy.sh        # both stacks; the first run takes about 30 minutes (MSK)
./aws/deploy/status.sh
```

The web app and the API share one URL (the `ApiUrl` printed by `03-deploy.sh`): the pages, `/docs` and
`/health` are public, and everything under `/v1/` needs a Cognito token. The browser signs in to Cognito
directly with email and password.

Create users (the password is typed in, not passed as an argument):

```bash
./aws/deploy/create-user.sh ops@example.com admin                      # distributor operations
./aws/deploy/create-user.sh rep@example.com sales_rep                  # sales rep
./aws/deploy/create-user.sh buyer@example.com retailer ACC-FL-1001     # retail user (Bayside Liquors)
```

Run the smoke test against AWS:

```bash
BASE_URL=<ApiUrl> TOKEN=$(./aws/deploy/get-token.sh ops@example.com) ./scripts/smoke-test.sh
```

To deploy new code, run `02-build-push.sh` and then `03-deploy.sh`.

### Cost and teardown

Roughly **$140–150 a month** in us-east-1 while running:

| Item | Monthly |
|---|---|
| MSK (2 × kafka.t3.small) | about $70 |
| RDS db.t4g.micro | about $15 |
| Fargate (4 small ARM tasks) | about $29 |
| ALB | about $16 |
| Public IPv4 addresses | about $15 |
| Secrets, KMS, logs, API Gateway | a few dollars |

Delete everything when you're not using it:

```bash
./aws/deploy/teardown.sh
```

## What I'd add for production

- **Real sources of record:** sync licenses from state agencies (many publish license lookups), credit status
  from accounts receivable, and posted prices from the pricing system, instead of seeded tables.
- **Excise tax and invoicing:** state excise and sales tax per line, and invoices on delivery.
- **More rules:** state minimum pricing, quantity limits, franchise/territory rules (which distributor may sell
  a brand in a territory) and holiday delivery calendars.
- **Industry-standard depletion formats** expected by suppliers' reporting systems, delivered over SFTP.
- **Event contracts:** Avro or JSON Schema in a schema registry (AWS Glue Schema Registry), plus contract tests.
- **Least-privilege databases:** a separate database user per service schema instead of the shared admin user.
- **Operations:** dashboards and alerts on consumer lag and dead-letter topics; a tool to replay dead letters;
  autoscaling on consumer lag; RDS Multi-AZ and three MSK brokers.

## Project layout

```
services/order-api/            Node.js + TypeScript REST API, outbox relay, event consumer
services/compliance-service/   Python FastAPI: state rules (app/rules.py), Kafka consumers, depletion feeds
services/inventory-allocator/  Rust: allocation algorithm (src/allocate.rs), Kafka consumer, HTTP
gateway/                       nginx config used locally (mirrors the AWS routing)
scripts/                       local stack (dev.sh) and end-to-end smoke test
aws/deploy/                    CloudFormation templates and deployment scripts
docker-compose.yml             local Kafka, Postgres, services and gateway
```
