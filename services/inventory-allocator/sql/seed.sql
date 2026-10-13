-- Demo warehouses and stock. Johnnie Walker Blue Label (SKU-SC-2004) is an allocated, scarce item, to show
-- split and failed allocations; restock it with a purchase order.
INSERT INTO inventory.warehouses (id, name, state, priority) VALUES
    ('WH-FL-ORL', 'Orlando',     'FL', 1), ('WH-FL-MIA', 'Miami',   'FL', 2),
    ('WH-TX-DAL', 'Dallas',      'TX', 1), ('WH-TX-HOU', 'Houston', 'TX', 2),
    ('WH-NY-SYR', 'Syracuse',    'NY', 1), ('WH-CA-LA',  'Los Angeles', 'CA', 1),
    ('WH-GA-ATL', 'Atlanta',     'GA', 1)
ON CONFLICT DO NOTHING;

INSERT INTO inventory.stock (warehouse_id, sku, on_hand_cases)
SELECT w.id, s.sku,
       CASE WHEN s.sku <> 'SKU-SC-2004' THEN 300
            WHEN w.id = 'WH-FL-ORL' THEN 5 WHEN w.id = 'WH-FL-MIA' THEN 3 WHEN w.id = 'WH-TX-DAL' THEN 4 ELSE 2 END
FROM inventory.warehouses w
CROSS JOIN (VALUES ('SKU-SC-2001'), ('SKU-SC-2002'), ('SKU-SC-2003'), ('SKU-SC-2004'),
                   ('SKU-VK-1001'), ('SKU-VK-1002'), ('SKU-VK-1003'),
                   ('SKU-WN-3001'), ('SKU-WN-3002'), ('SKU-BR-4001'), ('SKU-BR-4002')) AS s (sku)
ON CONFLICT DO NOTHING;
