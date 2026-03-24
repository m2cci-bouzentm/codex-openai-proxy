FROM node:22-slim

RUN apt-get update && apt-get install -y wget curl && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install codex CLI
RUN npm install -g @openai/codex

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js ./

# Codex auth mounted at runtime via volume
RUN mkdir -p /root/.codex

EXPOSE 3033

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3033/health || exit 1

CMD ["node", "index.js"]
