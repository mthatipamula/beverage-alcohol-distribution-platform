-- Demo compliance data. State rules are ILLUSTRATIVE, not legal advice: real rules differ by state and change.
INSERT INTO compliance.state_rules (state, name, credit_law, price_posting, sunday_delivery, saturday_delivery, notes) VALUES
    ('FL', 'Florida',    TRUE,  FALSE, FALSE, TRUE, 'Credit law; no Sunday deliveries'),
    ('TX', 'Texas',      TRUE,  FALSE, FALSE, TRUE, 'Credit law; no Sunday deliveries'),
    ('NY', 'New York',   TRUE,  TRUE,  FALSE, TRUE, 'Credit law and price posting'),
    ('CA', 'California', FALSE, FALSE, TRUE,  TRUE, 'Sunday deliveries allowed'),
    ('GA', 'Georgia',    TRUE,  TRUE,  FALSE, TRUE, 'Credit law and price posting')
ON CONFLICT DO NOTHING;

INSERT INTO compliance.licenses (account_id, license_number, state, license_type, status, expires_on) VALUES
    ('ACC-FL-1001', 'FL-BEV-100231', 'FL', 'FULL_LIQUOR', 'ACTIVE',    current_date + 365),
    ('ACC-FL-1002', 'FL-BEV-100877', 'FL', 'BEER_WINE',   'ACTIVE',    current_date + 365),
    ('ACC-TX-2001', 'TX-MB-552310',  'TX', 'FULL_LIQUOR', 'ACTIVE',    current_date + 365),
    ('ACC-TX-2002', 'TX-BG-552998',  'TX', 'BEER_ONLY',   'ACTIVE',    current_date + 365),
    ('ACC-NY-3001', 'NY-L-0045521',  'NY', 'FULL_LIQUOR', 'ACTIVE',    current_date + 365),
    ('ACC-CA-4001', 'CA-47-601122',  'CA', 'BEER_WINE',   'SUSPENDED', current_date + 365),
    ('ACC-GA-5001', 'GA-RET-77120',  'GA', 'FULL_LIQUOR', 'ACTIVE',    current_date + 3)
ON CONFLICT DO NOTHING;

INSERT INTO compliance.account_credit (account_id, delinquent, outstanding_cents) VALUES
    ('ACC-FL-1001', FALSE, 0), ('ACC-FL-1002', FALSE, 0), ('ACC-TX-2001', TRUE, 1845000),
    ('ACC-TX-2002', FALSE, 0), ('ACC-NY-3001', FALSE, 0), ('ACC-CA-4001', FALSE, 0), ('ACC-GA-5001', FALSE, 0)
ON CONFLICT DO NOTHING;

-- Posted prices for price-posting states (same base x state factor as the order API's price list).
WITH base (sku, cents) AS (VALUES
        ('SKU-SC-2001', 37200), ('SKU-SC-2002', 22800), ('SKU-SC-2003', 46800), ('SKU-SC-2004', 108000),
        ('SKU-VK-1001', 22800), ('SKU-VK-1002', 33600), ('SKU-VK-1003', 13200),
        ('SKU-WN-3001', 13800), ('SKU-WN-3002', 12600), ('SKU-BR-4001', 3150), ('SKU-BR-4002', 3300)),
     factor (state, f) AS (VALUES ('NY', 1.06), ('GA', 1.00)),
     months (m) AS (VALUES (date_trunc('month', current_date)::date),
                           ((date_trunc('month', current_date) + interval '1 month')::date))
INSERT INTO compliance.posted_prices (state, sku, effective_month, price_per_case_cents)
SELECT f.state, b.sku, m.m, round(b.cents * f.f)::bigint
FROM base b CROSS JOIN factor f CROSS JOIN months m
ON CONFLICT DO NOTHING;
