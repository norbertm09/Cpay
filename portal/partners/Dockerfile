FROM node:20-alpine AS builder
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

FROM nginx:1.25-alpine
COPY --from=builder /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
