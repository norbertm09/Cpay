FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
ARG REACT_APP_API_BASE_URL=https://api.c-pay.global
# Vite (vite.config.js, envPrefix REACT_APP_) lit toujours REACT_APP_API_BASE_URL au build.
ENV REACT_APP_API_BASE_URL=$REACT_APP_API_BASE_URL
# Aligne sur docker/Dockerfile.portal : build/ sans <script> inline (CSP script-src 'self'),
# garanti par vite.config.js (modulePreload.polyfill: false).
RUN npm run build

# Lot 7 (audit 2026-11-02 infra P2-8/P2-9) : nginx non privilegie, port 8080, healthcheck
FROM nginxinc/nginx-unprivileged:1.31-alpine
USER root
COPY --from=builder /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
RUN chown -R nginx:nginx /usr/share/nginx/html && nginx -t
USER nginx
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
