-- Demo data. Retail accounts are fictional. Brand names are real products used for illustration only;
-- prices and costs are illustrative, not actual wholesale prices. SKUs and the price formula are shared with
-- the compliance and inventory services so the demo data lines up across services.
INSERT INTO orders.accounts (id, name, state, channel) VALUES
    ('ACC-FL-1001', 'Bayside Liquors',          'FL', 'OFF_PREMISE'),
    ('ACC-FL-1002', 'Ocean Grill',              'FL', 'ON_PREMISE'),
    ('ACC-TX-2001', 'Lone Star Spirits',        'TX', 'OFF_PREMISE'),
    ('ACC-TX-2002', 'Austin Taproom',           'TX', 'ON_PREMISE'),
    ('ACC-NY-3001', 'Hudson Wine & Spirits',    'NY', 'OFF_PREMISE'),
    ('ACC-CA-4001', 'Sunset Bistro',            'CA', 'ON_PREMISE'),
    ('ACC-GA-5001', 'Peach State Package Store','GA', 'OFF_PREMISE')
ON CONFLICT DO NOTHING;

INSERT INTO orders.suppliers (id, name) VALUES
    ('SUP-DIAGEO',        'Diageo'),
    ('SUP-WGS',           'William Grant & Sons'),
    ('SUP-FIFTHGEN',      'Fifth Generation Inc.'),
    ('SUP-BACARDI',       'Bacardi USA'),
    ('SUP-JFW',           'Jackson Family Wines'),
    ('SUP-DEUTSCH',       'Deutsch Family Wine & Spirits'),
    ('SUP-CONSTELLATION', 'Constellation Brands'),
    ('SUP-HEINEKEN',      'Heineken USA')
ON CONFLICT DO NOTHING;

-- supplier_cost_cents is 75% of the base case price.
INSERT INTO orders.products (sku, name, brand, category, subcategory, supplier_id, units_per_case, unit_size, abv_pct, supplier_cost_cents) VALUES
    ('SKU-SC-2001', 'Johnnie Walker Black Label 12 Year Blended Scotch', 'Johnnie Walker', 'SPIRITS', 'SCOTCH', 'SUP-DIAGEO',        12, '750ml', 40.0, 27900),
    ('SKU-SC-2002', 'Johnnie Walker Red Label Blended Scotch',           'Johnnie Walker', 'SPIRITS', 'SCOTCH', 'SUP-DIAGEO',        12, '750ml', 40.0, 17100),
    ('SKU-SC-2003', 'Glenfiddich 12 Year Single Malt Scotch',            'Glenfiddich',    'SPIRITS', 'SCOTCH', 'SUP-WGS',           12, '750ml', 40.0, 35100),
    ('SKU-SC-2004', 'Johnnie Walker Blue Label Blended Scotch',          'Johnnie Walker', 'SPIRITS', 'SCOTCH', 'SUP-DIAGEO',         6, '750ml', 40.0, 81000),
    ('SKU-VK-1001', 'Tito''s Handmade Vodka',                            'Tito''s',        'SPIRITS', 'VODKA',  'SUP-FIFTHGEN',      12, '750ml', 40.0, 17100),
    ('SKU-VK-1002', 'Grey Goose Vodka',                                  'Grey Goose',     'SPIRITS', 'VODKA',  'SUP-BACARDI',       12, '750ml', 40.0, 25200),
    ('SKU-VK-1003', 'Smirnoff No. 21 Vodka',                             'Smirnoff',       'SPIRITS', 'VODKA',  'SUP-DIAGEO',        12, '750ml', 40.0,  9900),
    ('SKU-WN-3001', 'Kendall-Jackson Vintner''s Reserve Chardonnay',     'Kendall-Jackson','WINE',    'WINE',   'SUP-JFW',           12, '750ml', 13.5, 10350),
    ('SKU-WN-3002', 'Josh Cellars Cabernet Sauvignon',                   'Josh Cellars',   'WINE',    'WINE',   'SUP-DEUTSCH',       12, '750ml', 13.5,  9450),
    ('SKU-BR-4001', 'Corona Extra (24 x 12oz bottles)',                  'Corona',         'BEER',    'BEER',   'SUP-CONSTELLATION', 24, '12oz',   4.6,  2363),
    ('SKU-BR-4002', 'Heineken (24 x 12oz bottles)',                      'Heineken',       'BEER',    'BEER',   'SUP-HEINEKEN',      24, '12oz',   5.0,  2475)
ON CONFLICT DO NOTHING;

-- Price per case = base price x state factor, for this month and next month.
WITH base (sku, cents) AS (VALUES
        ('SKU-SC-2001', 37200), ('SKU-SC-2002', 22800), ('SKU-SC-2003', 46800), ('SKU-SC-2004', 108000),
        ('SKU-VK-1001', 22800), ('SKU-VK-1002', 33600), ('SKU-VK-1003', 13200),
        ('SKU-WN-3001', 13800), ('SKU-WN-3002', 12600), ('SKU-BR-4001', 3150), ('SKU-BR-4002', 3300)),
     factor (state, f) AS (VALUES ('FL', 1.00), ('TX', 0.98), ('NY', 1.06), ('CA', 1.02), ('GA', 1.00)),
     months (m) AS (VALUES (date_trunc('month', current_date)::date),
                           ((date_trunc('month', current_date) + interval '1 month')::date))
INSERT INTO orders.product_prices (sku, state, effective_month, price_per_case_cents)
SELECT b.sku, f.state, m.m, round(b.cents * f.f)::bigint
FROM base b CROSS JOIN factor f CROSS JOIN months m
ON CONFLICT DO NOTHING;
