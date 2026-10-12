use std::{fs::File, io::BufReader};

use anyhow::Context;
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use tokio_postgres::config::SslMode;
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::config::Config;

pub fn create_pool(cfg: &Config) -> anyhow::Result<Pool> {
    let mut pg = tokio_postgres::Config::new();
    pg.host(&cfg.db_host)
        .port(cfg.db_port)
        .dbname(&cfg.db_name)
        .user(&cfg.db_user)
        .password(&cfg.db_password);

    // One TLS connector type for both modes: with SslMode::Disable it is never used (local Docker).
    let mut roots = rustls::RootCertStore::empty();
    match &cfg.db_ssl_ca {
        Some(path) => {
            let mut reader = BufReader::new(File::open(path).with_context(|| format!("opening {path}"))?);
            for cert in rustls_pemfile::certs(&mut reader) {
                roots.add(cert?)?;
            }
            pg.ssl_mode(SslMode::Require);
        }
        None => {
            pg.ssl_mode(SslMode::Disable);
        }
    }
    let tls = MakeRustlsConnect::new(
        rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth(),
    );
    let manager = Manager::from_config(pg, tls, ManagerConfig { recycling_method: RecyclingMethod::Fast });
    Ok(Pool::builder(manager).max_size(8).build()?)
}

/// Creates the schema (idempotent) and loads demo warehouses and stock when empty.
pub async fn migrate(pool: &Pool, seed: bool) -> anyhow::Result<()> {
    let client = pool.get().await?;
    client.batch_execute(include_str!("../sql/schema.sql")).await?;
    if seed {
        let row = client.query_one("SELECT count(*) FROM inventory.warehouses", &[]).await?;
        if row.get::<_, i64>(0) == 0 {
            client.batch_execute(include_str!("../sql/seed.sql")).await?;
            tracing::info!("Loaded demo warehouses and stock");
        }
    }
    Ok(())
}
