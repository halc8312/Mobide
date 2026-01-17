FROM node:20-slim

WORKDIR /app

# Docker CLI を入れる（ホストの /var/run/docker.sock を叩くため）
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL https://get.docker.com | sh \
 && rm -rf /var/lib/apt/lists/*

# 先に依存だけ入れてキャッシュを効かせる
COPY package*.json ./
RUN npm ci --omit=dev

# アプリ本体
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
