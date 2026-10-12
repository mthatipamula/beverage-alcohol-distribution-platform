"""Runtime configuration from environment variables. Local defaults match docker-compose.yml."""
import os

PORT = int(os.getenv("PORT", "8080"))

DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = int(os.getenv("DB_PORT", "5436"))
DB_NAME = os.getenv("DB_NAME", "bevdist")
DB_USER = os.getenv("DB_USER", "bevdist")
DB_PASSWORD = os.getenv("DB_PASSWORD", "bevdist")
DB_SSL_CA = os.getenv("DB_SSL_CA")  # e.g. the Amazon RDS bundle; when set, TLS is required

KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "localhost:9092")
KAFKA_SASL_USERNAME = os.getenv("KAFKA_SASL_USERNAME")  # Amazon MSK SASL/SCRAM over TLS
KAFKA_SASL_PASSWORD = os.getenv("KAFKA_SASL_PASSWORD")

AUTH_MODE = os.getenv("AUTH_MODE", "api-key")  # api-key (local) | jwt (Cognito, AWS)
COGNITO_ISSUER = os.getenv("COGNITO_ISSUER")
COGNITO_CLIENT_ID = os.getenv("COGNITO_CLIENT_ID")

SEED_DEMO_DATA = os.getenv("SEED_DEMO_DATA", "true") == "true"
FEEDS_BUCKET = os.getenv("FEEDS_BUCKET")              # S3 bucket for supplier depletion feeds (AWS)
FEEDS_DIR = os.getenv("FEEDS_DIR", "/data/feeds")     # local folder when no bucket is set
FEED_SCHEDULE_ENABLED = os.getenv("FEED_SCHEDULE_ENABLED", "true") == "true"
BUSINESS_TIMEZONE = os.getenv("BUSINESS_TIMEZONE", "America/New_York")
DISTRIBUTOR_ID = os.getenv("DISTRIBUTOR_ID", "BEVDIST")
