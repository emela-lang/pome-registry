# リポジトリの根を context にしてビルドする:
#   docker build -f packages/ingester/Dockerfile .

FROM node:22-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/sumdb/package.json packages/sumdb/
COPY packages/proxy/package.json packages/proxy/
COPY packages/ingester/package.json packages/ingester/
RUN pnpm install --frozen-lockfile --filter @pome-registry/ingester...
COPY packages/protocol packages/protocol
COPY packages/ingester packages/ingester
RUN pnpm --filter @pome-registry/ingester build

FROM node:22-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/packages/ingester/dist/main.js /app/main.js
USER node
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "/app/main.js"]
