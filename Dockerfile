FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY docs ./docs
COPY scripts ./scripts
# 以 root 运行：宿主机 bind mount 的数据目录常由 Docker 以 root 创建，
# 非 root 用户无写权限会报 SQLITE_CANTOPEN，root 运行则开箱即用（自托管工具常见做法）
RUN mkdir -p /app/data
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
CMD ["node", "src/server.js"]
