use std::env;

#[derive(Clone)]
pub struct Config {
    pub port: u16,
    pub db_host: String,
    pub db_port: u16,
    pub db_name: String,
    pub db_user: String,
    pub db_password: String,
    /// CA bundle (e.g. Amazon RDS); when set, TLS is required for the database.
    pub db_ssl_ca: Option<String>,
    pub kafka_brokers: String,
    /// Amazon MSK SASL/SCRAM over TLS; unset for local plaintext Kafka.
    pub kafka_sasl: Option<(String, String)>,
    pub seed_demo_data: bool,
    pub auth_mode: String,
}

fn var(name: &str, default: &str) -> String {
    env::var(name).unwrap_or_else(|_| default.to_string())
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let sasl = match (env::var("KAFKA_SASL_USERNAME"), env::var("KAFKA_SASL_PASSWORD")) {
            (Ok(user), Ok(pass)) if !user.is_empty() => Some((user, pass)),
            _ => None,
        };
        Ok(Config {
            port: var("PORT", "8080").parse()?,
            db_host: var("DB_HOST", "localhost"),
            db_port: var("DB_PORT", "5436").parse()?,
            db_name: var("DB_NAME", "bevdist"),
            db_user: var("DB_USER", "bevdist"),
            db_password: var("DB_PASSWORD", "bevdist"),
            db_ssl_ca: env::var("DB_SSL_CA").ok().filter(|v| !v.is_empty()),
            kafka_brokers: var("KAFKA_BROKERS", "localhost:9092"),
            kafka_sasl: sasl,
            seed_demo_data: var("SEED_DEMO_DATA", "true") == "true",
            auth_mode: var("AUTH_MODE", "api-key"),
        })
    }
}
