FROM node:22-alpine AS build
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /web/dist /usr/share/nginx/html
COPY docker-entrypoint.sh /docker-entrypoint-web.sh
RUN chmod +x /docker-entrypoint-web.sh
EXPOSE 8080
ENTRYPOINT ["/docker-entrypoint-web.sh"]
