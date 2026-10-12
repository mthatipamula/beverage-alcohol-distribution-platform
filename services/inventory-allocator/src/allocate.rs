//! Allocation algorithm: pure, so it is unit-tested without Kafka or a database.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    pub line_no: i32,
    pub sku: String,
    pub quantity_cases: i64,
}

/// Available stock in one warehouse, already sorted by shipping priority.
#[derive(Debug, Clone)]
pub struct Stock {
    pub warehouse_id: String,
    pub sku: String,
    pub available: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Allocation {
    pub line_no: i32,
    pub sku: String,
    pub warehouse_id: String,
    pub quantity_cases: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shortage {
    pub code: String,
    pub message: String,
    pub line_no: i32,
}

/// All-or-nothing: either every line is fully allocated or nothing is reserved.
/// Lines are filled from the highest-priority warehouse first and may be split across warehouses.
pub fn allocate(lines: &[Line], stock: &[Stock]) -> Result<Vec<Allocation>, Vec<Shortage>> {
    // Check totals per SKU first, so several lines for the same SKU are judged together.
    let mut requested: HashMap<&str, (i64, i32)> = HashMap::new();
    for line in lines {
        let entry = requested.entry(line.sku.as_str()).or_insert((0, line.line_no));
        entry.0 += line.quantity_cases;
    }
    let mut shortages: Vec<Shortage> = requested
        .iter()
        .filter_map(|(sku, (wanted, first_line))| {
            let available: i64 = stock.iter().filter(|s| s.sku == *sku).map(|s| s.available.max(0)).sum();
            (available < *wanted).then(|| Shortage {
                code: "INSUFFICIENT_STOCK".into(),
                message: format!("{sku}: {wanted} cases requested, {available} available in-state"),
                line_no: *first_line,
            })
        })
        .collect();
    if !shortages.is_empty() {
        shortages.sort_by_key(|s| s.line_no);
        return Err(shortages);
    }

    let mut remaining: Vec<Stock> = stock.to_vec();
    let mut allocations = Vec::new();
    for line in lines {
        let mut needed = line.quantity_cases;
        for s in remaining.iter_mut().filter(|s| s.sku == line.sku && s.available > 0) {
            if needed == 0 {
                break;
            }
            let take = needed.min(s.available);
            s.available -= take;
            needed -= take;
            allocations.push(Allocation {
                line_no: line.line_no,
                sku: line.sku.clone(),
                warehouse_id: s.warehouse_id.clone(),
                quantity_cases: take,
            });
        }
    }
    Ok(allocations)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(no: i32, sku: &str, qty: i64) -> Line {
        Line { line_no: no, sku: sku.into(), quantity_cases: qty }
    }

    fn stock(wh: &str, sku: &str, available: i64) -> Stock {
        Stock { warehouse_id: wh.into(), sku: sku.into(), available }
    }

    #[test]
    fn fills_from_the_first_warehouse_when_it_has_enough() {
        let result = allocate(&[line(1, "A", 4)], &[stock("ORL", "A", 10), stock("MIA", "A", 10)]).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!((result[0].warehouse_id.as_str(), result[0].quantity_cases), ("ORL", 4));
    }

    #[test]
    fn splits_a_line_across_warehouses_in_priority_order() {
        let result = allocate(&[line(1, "RYE", 6)], &[stock("ORL", "RYE", 5), stock("MIA", "RYE", 3)]).unwrap();
        let parts: Vec<_> = result.iter().map(|a| (a.warehouse_id.as_str(), a.quantity_cases)).collect();
        assert_eq!(parts, vec![("ORL", 5), ("MIA", 1)]);
    }

    #[test]
    fn fails_the_whole_order_when_any_sku_is_short() {
        let err = allocate(
            &[line(1, "A", 2), line(2, "RYE", 50)],
            &[stock("ORL", "A", 10), stock("ORL", "RYE", 5), stock("MIA", "RYE", 3)],
        )
        .unwrap_err();
        assert_eq!(err.len(), 1);
        assert_eq!(err[0].line_no, 2);
        assert!(err[0].message.contains("50 cases requested, 8 available"));
    }

    #[test]
    fn lines_for_the_same_sku_share_the_stock() {
        assert!(allocate(&[line(1, "A", 6), line(2, "A", 6)], &[stock("ORL", "A", 10)]).is_err());
        let ok = allocate(&[line(1, "A", 6), line(2, "A", 4)], &[stock("ORL", "A", 10)]).unwrap();
        assert_eq!(ok.iter().map(|a| a.quantity_cases).sum::<i64>(), 10);
    }

    #[test]
    fn unknown_sku_is_a_shortage() {
        let err = allocate(&[line(1, "NOPE", 1)], &[stock("ORL", "A", 10)]).unwrap_err();
        assert!(err[0].message.contains("0 available"));
    }
}
