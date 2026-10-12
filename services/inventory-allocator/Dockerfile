FROM rust:1.99-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends cmake perl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Build dependencies first so code changes don't rebuild librdkafka and OpenSSL.
COPY Cargo.toml Cargo.lock* ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src
COPY src src
COPY sql sql
RUN touch src/main.rs && cargo test --release && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
# Amazon RDS certificate bundle, used when DB_SSL_CA points at it (AWS deployment).
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/rds-global-bundle.pem
RUN chmod 644 /etc/ssl/rds-global-bundle.pem && useradd --system --uid 10001 app
COPY --from=build /app/target/release/inventory-allocator /usr/local/bin/inventory-allocator
USER 10001
ENV PORT=8080 RUST_LOG=info
EXPOSE 8080
CMD ["inventory-allocator"]
