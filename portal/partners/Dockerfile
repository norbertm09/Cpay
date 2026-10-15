FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --legacy-peer-deps && \
    npm install ajv@^8.0.0 --legacy-peer-deps
COPY public ./public
COPY src ./src
ARG REACT_APP_API_BASE_URL=https://api.c-pay.global
ENV REACT_APP_API_BASE_URL=$REACT_APP_API_BASE_URL
# Aligne sur docker/Dockerfile.portal : pas de <script> inline,
# sinon la CSP script-src 'self' casse le portail en mode enforce.
ENV INLINE_RUNTIME_CHUNK=false
ENV CI=false
RUN npm run build

FROM nginx:1.25-alpine
COPY --from=builder /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
