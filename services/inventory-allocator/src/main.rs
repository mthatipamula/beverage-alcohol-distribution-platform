//! Inventory allocator: consumes validated orders from Kafka and reserves stock in in-state warehouses.

mod allocate;
mod config;
mod consumer;
mod db;
mod http;

use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().json().with_env_filter(EnvFilter::from_default_env()).init();
    let _ = rustls::crypto::ring::default_provider().install_default();

    let cfg = config::Config::from_env()?;
    let pool = db::create_pool(&cfg)?;
    db::migrate(&pool, cfg.seed_demo_data).await?;
    let producer = consumer::producer(&cfg)?;

    let app = http::router(http::AppState { pool: pool.clone(), auth_mode: cfg.auth_mode.clone() });
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", cfg.port)).await?;
    tracing::info!(port = cfg.port, "HTTP listening");

    // If either the consumer or the HTTP server stops, exit so the orchestrator restarts the task.
    tokio::select! {
        result = consumer::run(cfg.clone(), pool, producer) => result,
        result = axum::serve(listener, app) => result.map_err(Into::into),
        _ = tokio::signal::ctrl_c() => Ok(()),
    }
}
