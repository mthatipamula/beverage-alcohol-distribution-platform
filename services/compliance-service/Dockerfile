FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080
# Amazon RDS certificate bundle, used when DB_SSL_CA points at it (AWS deployment).
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/rds-global-bundle.pem
RUN chmod 644 /etc/ssl/rds-global-bundle.pem
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app app
COPY sql sql
RUN useradd --system --uid 10001 app && mkdir -p /data/feeds && chown app /data/feeds
USER 10001
EXPOSE 8080
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --no-access-log"]
