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
RUN mkdir -p /app/data && chown -R node:node /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
USER node
CMD ["node", "src/server.js"]
