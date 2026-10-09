FROM node:22-slim AS builder

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates procps wget \
    && rm -rf /var/lib/apt/lists/*

# Install pinned official @openai/codex CLI
RUN npm install -g @openai/codex@0.160.0

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY bin/ ./bin/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Link proxy-auth to global PATH
RUN chmod +x ./bin/proxy-auth /usr/local/bin/docker-entrypoint.sh \
    && ln -s /app/bin/proxy-auth /usr/local/bin/proxy-auth

# Default auth and data directory
RUN mkdir -p /data && chmod 700 /data

EXPOSE 3033

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3033/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
