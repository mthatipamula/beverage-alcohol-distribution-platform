"""State compliance rules for a three-tier alcohol distributor. Pure functions, so they are easy to test.

The rules are illustrative: real requirements differ by state and change over time, and would be maintained
with the compliance team.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

# Which product categories each retail license type may buy.
LICENSE_CATEGORIES: dict[str, set[str]] = {
    "BEER_ONLY": {"BEER"},
    "BEER_WINE": {"BEER", "WINE"},
    "FULL_LIQUOR": {"BEER", "WINE", "SPIRITS"},
}


@dataclass(frozen=True)
class StateRule:
    state: str
    name: str
    credit_law: bool
    price_posting: bool
    sunday_delivery: bool
    saturday_delivery: bool


@dataclass(frozen=True)
class License:
    account_id: str
    license_number: str
    state: str
    license_type: str
    status: str
    expires_on: date


@dataclass(frozen=True)
class Credit:
    delinquent: bool
    outstanding_cents: int


@dataclass(frozen=True)
class Line:
    line_no: int
    sku: str
    category: str
    quantity_cases: int
    unit_price_cents: int


@dataclass(frozen=True)
class Order:
    order_id: str
    account_id: str
    state: str
    payment_terms: str
    delivery_date: date
    lines: list[Line]


@dataclass
class Decision:
    approved: bool = True
    reasons: list[dict] = field(default_factory=list)
    checks: list[str] = field(default_factory=list)

    def reject(self, code: str, message: str, line_no: int | None = None) -> None:
        self.approved = False
        reason = {"code": code, "message": message}
        if line_no is not None:
            reason["lineNo"] = line_no
        self.reasons.append(reason)


def evaluate(
    order: Order,
    rule: StateRule | None,
    license: License | None,
    credit: Credit | None,
    posted_prices: dict[str, int],
) -> Decision:
    """Runs every check and collects all failures, so a sales rep sees everything to fix at once."""
    d = Decision()

    d.checks.append("STATE_SERVED")
    if rule is None:
        d.reject("STATE_NOT_SERVED", f"No compliance rules are configured for {order.state}")
        return d

    d.checks.append("LICENSE")
    if license is None:
        d.reject("LICENSE_MISSING", f"No retail license on file for account {order.account_id}")
    else:
        if license.state != order.state:
            d.reject("LICENSE_STATE_MISMATCH",
                     f"License {license.license_number} is issued in {license.state}, not {order.state}")
        if license.status != "ACTIVE":
            d.reject("LICENSE_NOT_ACTIVE", f"License {license.license_number} is {license.status.lower()}")
        elif license.expires_on < order.delivery_date:
            d.reject("LICENSE_EXPIRES_BEFORE_DELIVERY",
                     f"License {license.license_number} expires {license.expires_on}, before delivery on {order.delivery_date}")

        d.checks.append("LICENSE_CATEGORY")
        allowed = LICENSE_CATEGORIES.get(license.license_type, set())
        for line in order.lines:
            if line.category not in allowed:
                d.reject("LICENSE_CATEGORY",
                         f"A {license.license_type.replace('_', ' ').lower()} license cannot buy {line.category.lower()} ({line.sku})",
                         line.line_no)

    if rule.credit_law:
        d.checks.append("CREDIT_LAW")
        if credit is not None and credit.delinquent and order.payment_terms != "COD":
            d.reject("CREDIT_LAW_COD_REQUIRED",
                     f"Account is delinquent (${credit.outstanding_cents / 100:,.2f} outstanding); "
                     f"{rule.name} credit law allows cash on delivery only")

    if rule.price_posting:
        d.checks.append("PRICE_POSTING")
        for line in order.lines:
            posted = posted_prices.get(line.sku)
            if posted is None:
                d.reject("PRICE_NOT_POSTED", f"No posted price for {line.sku} in {rule.name}", line.line_no)
            elif line.unit_price_cents != posted:
                d.reject("PRICE_POSTING_VIOLATION",
                         f"{line.sku} priced at ${line.unit_price_cents / 100:,.2f} per case; "
                         f"{rule.name} posted price is ${posted / 100:,.2f}",
                         line.line_no)

    d.checks.append("DELIVERY_DAY")
    weekday = order.delivery_date.weekday()  # Monday = 0, Sunday = 6
    if (weekday == 6 and not rule.sunday_delivery) or (weekday == 5 and not rule.saturday_delivery):
        d.reject("DELIVERY_DAY_NOT_ALLOWED",
                 f"{rule.name} does not allow deliveries on {order.delivery_date.strftime('%A')}")

    return d
