"""End-to-end smoke test (Python standard library only). See smoke-test.sh for usage."""
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

BASE = os.environ.get("BASE_URL", "http://localhost:8090").rstrip("/")
TOKEN = os.environ.get("TOKEN")
AUTH = {"Authorization": f"Bearer {TOKEN}"} if TOKEN else {"X-API-Key": os.environ.get("API_KEY", "local-admin-key")}
TERMINAL = {"CONFIRMED", "REJECTED", "BACKORDERED"}
TODAY = datetime.now(ZoneInfo("America/New_York")).date()


def call(method, path, body=None, headers=None):
    content = {"Content-Type": "application/json"} if body is not None else {}
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={**content, **AUTH, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"null")


def next_day(after: int, weekdays: set[int]) -> str:
    d = TODAY + timedelta(days=after)
    while d.weekday() not in weekdays:
        d += timedelta(days=1)
    return d.isoformat()


WEEKDAY = next_day(1, {0, 1, 2, 3, 4})
AFTER_GA_EXPIRY = next_day(6, {0, 1, 2, 3, 4})
SUNDAY = next_day(1, {6})


def order(account, lines, terms="NET", delivery=WEEKDAY):
    return {"accountId": account, "deliveryDate": delivery, "paymentTerms": terms,
            "lines": [{"sku": s, "quantityCases": q, **({"discountPct": d} if d else {})} for s, q, d in lines]}


def place(body, key=None):
    return call("POST", "/v1/orders", body, {"Idempotency-Key": key or str(uuid.uuid4())})


def wait(order_id, timeout=45):
    deadline = time.time() + timeout
    while time.time() < deadline:
        _, o = call("GET", f"/v1/orders/{order_id}")
        if o and o.get("status") in TERMINAL:
            return o
        time.sleep(0.5)
    return o


results = []


def check(name, ok, detail):
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name:<52} {detail}")


def scenario(name, body, expect_status, expect_codes=()):
    status, placed = place(body)
    if status != 202:
        return check(name, False, f"HTTP {status}: {placed}")
    o = wait(placed["id"])
    codes = [r["code"] for r in o.get("statusReasons", [])]
    ok = o["status"] == expect_status and all(c in codes for c in expect_codes)
    check(name, ok, f"{o['status']} {codes or ''}".strip())
    return o


print(f"Smoke test against {BASE} (deliveries: weekday {WEEKDAY}, Sunday {SUNDAY})\n")

# Happy path and idempotency
body = order("ACC-FL-1001", [("SKU-SC-2001", 5, 0), ("SKU-WN-3002", 10, 0)])
key = str(uuid.uuid4())
status, first = place(body, key)
o = wait(first["id"]) if status == 202 else {}
check("Florida liquor store order is confirmed", o.get("status") == "CONFIRMED",
      f"{o.get('status')} total ${o.get('totalCents', 0) / 100:,.2f}")
status, again = place(body, key)
check("Retry with same Idempotency-Key returns same order", status == 200 and again.get("id") == first.get("id"),
      f"HTTP {status}, replay={again.get('idempotentReplay')}")
status, reused = place(order("ACC-FL-1001", [("SKU-SC-2001", 6, 0)]), key)
check("Same key with a different order is refused", status == 422, f"HTTP {status} {reused.get('code')}")

# State compliance
scenario("Beer & wine license cannot buy spirits", order("ACC-FL-1002", [("SKU-SC-2001", 2, 0)]),
         "REJECTED", ["LICENSE_CATEGORY"])
scenario("Suspended license is rejected", order("ACC-CA-4001", [("SKU-WN-3002", 2, 0)]),
         "REJECTED", ["LICENSE_NOT_ACTIVE"])
scenario("Delinquent account on NET terms (credit law)", order("ACC-TX-2001", [("SKU-VK-1001", 3, 0)]),
         "REJECTED", ["CREDIT_LAW_COD_REQUIRED"])
scenario("Delinquent account paying COD is allowed", order("ACC-TX-2001", [("SKU-VK-1001", 3, 0)], terms="COD"),
         "CONFIRMED")
scenario("Discount in a price-posting state is rejected", order("ACC-NY-3001", [("SKU-SC-2001", 4, 10)]),
         "REJECTED", ["PRICE_POSTING_VIOLATION"])
scenario("Posted price in a price-posting state is allowed", order("ACC-NY-3001", [("SKU-SC-2001", 4, 0)]),
         "CONFIRMED")
scenario("Sunday delivery where not allowed", order("ACC-FL-1001", [("SKU-BR-4001", 20, 0)], delivery=SUNDAY),
         "REJECTED", ["DELIVERY_DAY_NOT_ALLOWED"])
scenario("License expires before delivery", order("ACC-GA-5001", [("SKU-WN-3001", 5, 0)], delivery=AFTER_GA_EXPIRY),
         "REJECTED", ["LICENSE_EXPIRES_BEFORE_DELIVERY"])

# Inventory
_, stock = call("GET", "/v1/inventory?state=FL&sku=SKU-SC-2004")
available = sum(s["availableCases"] for s in stock or [])
if available >= 6:
    o = scenario(f"Scarce SKU split across warehouses ({available} available)",
                 order("ACC-FL-1001", [("SKU-SC-2004", 6, 0)]), "CONFIRMED")
    print(f"      allocations: {[(a['warehouseId'], a['quantityCases']) for a in (o.get('allocations') or [])]}")
else:
    print(f"SKIP  Scarce SKU split ({available} cases left; ./scripts/dev.sh reset restores stock)")
scenario("Order larger than in-state stock is backordered", order("ACC-FL-1001", [("SKU-SC-2004", 500, 0)]),
         "BACKORDERED", ["INSUFFICIENT_STOCK"])

# Distributor purchasing: receive Blue Label from Diageo into Orlando, then the stock is there
_, before = call("GET", "/v1/inventory?state=FL&sku=SKU-SC-2004")
on_hand_before = sum(s["onHandCases"] for s in before or [] if s["warehouseId"] == "WH-FL-ORL")
status, po = call("POST", "/v1/purchase-orders",
                  {"supplierId": "SUP-DIAGEO", "warehouseId": "WH-FL-ORL", "expectedDate": WEEKDAY,
                   "lines": [{"sku": "SKU-SC-2004", "quantityCases": 24}]},
                  {"Idempotency-Key": str(uuid.uuid4())})
if status == 201:
    rstatus, received = call("POST", f"/v1/purchase-orders/{po['id']}/receive")
    if rstatus != 200:
        print(f"      receive failed: HTTP {rstatus} {received}")
    on_hand_after = on_hand_before
    for _ in range(40):
        _, after = call("GET", "/v1/inventory?state=FL&sku=SKU-SC-2004")
        on_hand_after = sum(s["onHandCases"] for s in after or [] if s["warehouseId"] == "WH-FL-ORL")
        if on_hand_after > on_hand_before:
            break
        time.sleep(0.5)
    check("Receiving a supplier purchase order adds stock", on_hand_after == on_hand_before + 24,
          f"Orlando Blue Label {on_hand_before} -> {on_hand_after} cases (PO ${po['totalCostCents'] / 100:,.2f})")
else:
    check("Receiving a supplier purchase order adds stock", False, f"HTTP {status}: {po}")

# Supplier depletion feeds for the confirmed deliveries
time.sleep(2)
status, feeds = call("POST", f"/v1/depletions/feeds?date={WEEKDAY}")
suppliers = sorted(f["supplierId"] for f in (feeds or {}).get("feeds", []))
check("Supplier depletion feeds are generated", status == 200 and "SUP-DIAGEO" in suppliers,
      f"{suppliers} -> {(feeds or {}).get('feeds', [{}])[0].get('location', '')}")

failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
