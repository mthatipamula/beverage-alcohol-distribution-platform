// Runtime configuration from environment variables. Local defaults match docker-compose.yml.
const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

export const config = {
  port: Number(env('PORT', '8080')),
  db: {
    host: env('DB_HOST', 'localhost'),
    port: Number(env('DB_PORT', '5436')),
    database: env('DB_NAME', 'bevdist'),
    user: env('DB_USER', 'bevdist'),
    password: env('DB_PASSWORD', 'bevdist'),
    // Path to a CA bundle (e.g. the Amazon RDS bundle). When set, connections require TLS.
    sslCa: process.env.DB_SSL_CA,
  },
  kafka: {
    brokers: env('KAFKA_BROKERS', 'localhost:9092').split(','),
    // Amazon MSK uses SASL/SCRAM over TLS; local Kafka uses plaintext.
    saslUsername: process.env.KAFKA_SASL_USERNAME,
    saslPassword: process.env.KAFKA_SASL_PASSWORD,
    partitions: Number(env('KAFKA_TOPIC_PARTITIONS', '3')),
    replicationFactor: Number(env('KAFKA_REPLICATION_FACTOR', '1')),
  },
  auth: {
    // api-key: X-API-Key header (local). jwt: Cognito tokens (AWS; API Gateway also verifies them).
    mode: env('AUTH_MODE', 'api-key') as 'api-key' | 'jwt',
    cognitoIssuer: process.env.COGNITO_ISSUER,
    cognitoClientId: process.env.COGNITO_CLIENT_ID,
  },
  seedDemoData: env('SEED_DEMO_DATA', 'true') === 'true',
  timezone: env('BUSINESS_TIMEZONE', 'America/New_York'),
};
