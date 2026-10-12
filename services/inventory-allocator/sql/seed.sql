-- Demo warehouses and stock. SKU-SP-1003 (limited rye) is scarce, to show split and failed allocations.
INSERT INTO inventory.warehouses (id, name, state, priority) VALUES
    ('WH-FL-ORL', 'Orlando',     'FL', 1), ('WH-FL-MIA', 'Miami',   'FL', 2),
    ('WH-TX-DAL', 'Dallas',      'TX', 1), ('WH-TX-HOU', 'Houston', 'TX', 2),
    ('WH-NY-SYR', 'Syracuse',    'NY', 1), ('WH-CA-LA',  'Los Angeles', 'CA', 1),
    ('WH-GA-ATL', 'Atlanta',     'GA', 1)
ON CONFLICT DO NOTHING;

INSERT INTO inventory.stock (warehouse_id, sku, on_hand_cases)
SELECT w.id, s.sku,
       CASE WHEN s.sku <> 'SKU-SP-1003' THEN 2000
            WHEN w.id = 'WH-FL-ORL' THEN 5 WHEN w.id = 'WH-FL-MIA' THEN 3 WHEN w.id = 'WH-TX-DAL' THEN 4 ELSE 2 END
FROM inventory.warehouses w
CROSS JOIN (VALUES ('SKU-SP-1001'), ('SKU-SP-1002'), ('SKU-SP-1003'),
                   ('SKU-WN-2001'), ('SKU-WN-2002'), ('SKU-BR-3001')) AS s (sku)
ON CONFLICT DO NOTHING;
