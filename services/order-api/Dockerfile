FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
# Amazon RDS certificate bundle, used when DB_SSL_CA points at it (AWS deployment).
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/rds-global-bundle.pem
RUN chmod 644 /etc/ssl/rds-global-bundle.pem
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY package.json ./
COPY sql sql
USER node
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "dist/server.js"]
