from datetime import date

from app.rules import Credit, License, Line, Order, StateRule, evaluate

FL = StateRule("FL", "Florida", credit_law=True, price_posting=False, sunday_delivery=False, saturday_delivery=True)
NY = StateRule("NY", "New York", credit_law=True, price_posting=True, sunday_delivery=False, saturday_delivery=True)
TUESDAY = date(2026, 10, 13)
SUNDAY = date(2026, 10, 18)


def lic(**kw):
    base = dict(account_id="A1", license_number="L-1", state="FL", license_type="FULL_LIQUOR", status="ACTIVE",
                expires_on=date(2027, 1, 1))
    return License(**{**base, **kw})


def order(state="FL", terms="NET", delivery=TUESDAY, lines=None):
    lines = lines or [Line(1, "SKU-SP-1001", "SPIRITS", 5, 32400)]
    return Order("o1", "A1", state, terms, delivery, lines)


def codes(decision):
    return [r["code"] for r in decision.reasons]


def test_clean_order_is_approved():
    d = evaluate(order(), FL, lic(), Credit(False, 0), {})
    assert d.approved and d.reasons == []
    assert "LICENSE" in d.checks and "CREDIT_LAW" in d.checks and "PRICE_POSTING" not in d.checks


def test_wine_license_cannot_buy_spirits():
    d = evaluate(order(), FL, lic(license_type="BEER_WINE"), Credit(False, 0), {})
    assert codes(d) == ["LICENSE_CATEGORY"] and d.reasons[0]["lineNo"] == 1


def test_suspended_and_expiring_licenses():
    assert codes(evaluate(order(), FL, lic(status="SUSPENDED"), None, {})) == ["LICENSE_NOT_ACTIVE"]
    expiring = lic(expires_on=date(2026, 10, 12))
    assert codes(evaluate(order(), FL, expiring, None, {})) == ["LICENSE_EXPIRES_BEFORE_DELIVERY"]


def test_missing_license_and_unserved_state():
    assert codes(evaluate(order(), FL, None, None, {})) == ["LICENSE_MISSING"]
    assert codes(evaluate(order(), None, lic(), None, {})) == ["STATE_NOT_SERVED"]


def test_credit_law_requires_cod_for_delinquent_accounts():
    delinquent = Credit(True, 1845000)
    assert codes(evaluate(order(terms="NET"), FL, lic(), delinquent, {})) == ["CREDIT_LAW_COD_REQUIRED"]
    assert evaluate(order(terms="COD"), FL, lic(), delinquent, {}).approved


def test_price_posting_requires_the_posted_price():
    ny_lic = lic(state="NY")
    posted = {"SKU-SP-1001": 34344}
    ok = order(state="NY", lines=[Line(1, "SKU-SP-1001", "SPIRITS", 2, 34344)])
    discounted = order(state="NY", lines=[Line(1, "SKU-SP-1001", "SPIRITS", 2, 30910)])
    unposted = order(state="NY", lines=[Line(1, "SKU-WN-2001", "WINE", 2, 17808)])
    assert evaluate(ok, NY, ny_lic, None, posted).approved
    assert codes(evaluate(discounted, NY, ny_lic, None, posted)) == ["PRICE_POSTING_VIOLATION"]
    assert codes(evaluate(unposted, NY, ny_lic, None, posted)) == ["PRICE_NOT_POSTED"]


def test_sunday_delivery_and_multiple_failures_are_all_reported():
    d = evaluate(order(delivery=SUNDAY), FL, lic(license_type="BEER_ONLY", status="SUSPENDED"), Credit(True, 100), {})
    assert set(codes(d)) == {"LICENSE_NOT_ACTIVE", "LICENSE_CATEGORY", "CREDIT_LAW_COD_REQUIRED", "DELIVERY_DAY_NOT_ALLOWED"}
