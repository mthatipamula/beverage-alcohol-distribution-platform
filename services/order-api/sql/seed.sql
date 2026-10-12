-- Demo data (fictional accounts, brands and suppliers). Loaded only when SEED_DEMO_DATA=true and the
-- catalog is empty. Account IDs, SKUs and the price formula are shared with the compliance and inventory
-- services so the demo data lines up across services.
INSERT INTO orders.accounts (id, name, state, channel) VALUES
    ('ACC-FL-1001', 'Bayside Liquors',          'FL', 'OFF_PREMISE'),
    ('ACC-FL-1002', 'Ocean Grill',              'FL', 'ON_PREMISE'),
    ('ACC-TX-2001', 'Lone Star Spirits',        'TX', 'OFF_PREMISE'),
    ('ACC-TX-2002', 'Austin Taproom',           'TX', 'ON_PREMISE'),
    ('ACC-NY-3001', 'Hudson Wine & Spirits',    'NY', 'OFF_PREMISE'),
    ('ACC-CA-4001', 'Sunset Bistro',            'CA', 'ON_PREMISE'),
    ('ACC-GA-5001', 'Peach State Package Store','GA', 'OFF_PREMISE')
ON CONFLICT DO NOTHING;

INSERT INTO orders.products (sku, name, category, supplier_id, supplier_name, units_per_case, abv_pct) VALUES
    ('SKU-SP-1001', 'Harbor Reserve Bourbon 750ml',          'SPIRITS', 'SUP-100', 'Copper Still Distillers', 12, 45.0),
    ('SKU-SP-1002', 'Blue Agave Blanco Tequila 750ml',       'SPIRITS', 'SUP-100', 'Copper Still Distillers', 12, 40.0),
    ('SKU-SP-1003', 'Copper Still Single Barrel Rye 750ml',  'SPIRITS', 'SUP-100', 'Copper Still Distillers',  6, 55.0),
    ('SKU-WN-2001', 'Coastal Ridge Cabernet Sauvignon 750ml','WINE',    'SUP-200', 'Valley Crest Vineyards',  12, 13.5),
    ('SKU-WN-2002', 'Coastal Ridge Chardonnay 750ml',        'WINE',    'SUP-200', 'Valley Crest Vineyards',  12, 13.0),
    ('SKU-BR-3001', 'Gulf Coast Lager 12oz (24 pack)',       'BEER',    'SUP-300', 'Bayou Brewing Co.',       24,  4.8)
ON CONFLICT DO NOTHING;

-- Price per case = base price x state factor, for this month and next month.
WITH base (sku, cents) AS (VALUES
        ('SKU-SP-1001', 32400), ('SKU-SP-1002', 28800), ('SKU-SP-1003', 41400),
        ('SKU-WN-2001', 16800), ('SKU-WN-2002', 14400), ('SKU-BR-3001', 2650)),
     factor (state, f) AS (VALUES ('FL', 1.00), ('TX', 0.98), ('NY', 1.06), ('CA', 1.02), ('GA', 1.00)),
     months (m) AS (VALUES (date_trunc('month', current_date)::date),
                           ((date_trunc('month', current_date) + interval '1 month')::date))
INSERT INTO orders.product_prices (sku, state, effective_month, price_per_case_cents)
SELECT b.sku, f.state, m.m, round(b.cents * f.f)::bigint
FROM base b CROSS JOIN factor f CROSS JOIN months m
ON CONFLICT DO NOTHING;
