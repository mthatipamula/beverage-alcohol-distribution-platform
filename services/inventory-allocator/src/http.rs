//! Small HTTP surface: health for the load balancer and a read-only stock view.

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use deadpool_postgres::Pool;
use serde::Deserialize;
use serde_json::json;

#[derive(Clone)]
pub struct AppState {
    pub pool: Pool,
    pub auth_mode: String,
}

const API_KEYS: [&str; 2] = ["local-admin-key", "local-rep-key"];

pub fn router(state: AppState) -> Router {
    Router::new().route("/health", get(health)).route("/v1/inventory", get(inventory)).with_state(state)
}

async fn health(State(state): State<AppState>) -> Response {
    match state.pool.get().await {
        Ok(client) if client.simple_query("SELECT 1").await.is_ok() => Json(json!({ "status": "UP" })).into_response(),
        _ => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "status": "DOWN" }))).into_response(),
    }
}

#[derive(Deserialize)]
struct InventoryQuery {
    state: String,
    sku: Option<String>,
}

/// Locally the X-API-Key header is checked. On AWS, API Gateway verifies the Cognito token before a request
/// can reach this service (it is only reachable through the private load balancer).
fn authorized(state: &AppState, headers: &HeaderMap) -> bool {
    match state.auth_mode.as_str() {
        "api-key" => headers.get("x-api-key").and_then(|v| v.to_str().ok()).is_some_and(|k| API_KEYS.contains(&k)),
        _ => headers.contains_key("authorization"),
    }
}

async fn inventory(State(state): State<AppState>, headers: HeaderMap, Query(q): Query<InventoryQuery>) -> Response {
    if !authorized(&state, &headers) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "status": 401, "detail": "Admin or sales rep credentials required" })))
            .into_response();
    }
    let result = async {
        let client = state.pool.get().await?;
        let rows = client
            .query(
                "SELECT w.id, w.name, s.sku, s.on_hand_cases, s.reserved_cases
                 FROM inventory.stock s JOIN inventory.warehouses w ON w.id = s.warehouse_id
                 WHERE w.state = $1 AND ($2::text IS NULL OR s.sku = $2)
                 ORDER BY w.priority, w.id, s.sku",
                &[&q.state, &q.sku],
            )
            .await?;
        anyhow::Ok(
            rows.iter()
                .map(|r| {
                    let (on_hand, reserved): (i64, i64) = (r.get(3), r.get(4));
                    json!({ "warehouseId": r.get::<_, String>(0), "warehouse": r.get::<_, String>(1),
                            "sku": r.get::<_, String>(2), "onHandCases": on_hand, "reservedCases": reserved,
                            "availableCases": on_hand - reserved })
                })
                .collect::<Vec<_>>(),
        )
    }
    .await;
    match result {
        Ok(items) => Json(items).into_response(),
        Err(err) => {
            tracing::error!(error = %err, "Inventory query failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "status": 500 }))).into_response()
        }
    }
}
