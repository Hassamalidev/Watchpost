# Watchpost probe (PRODUCT.md §7.6, §16). Build context is the repo root:
#   docker build -f probe/Dockerfile -t watchpost-probe .
# ICMP checks need the NET_RAW capability at run time (docker run --cap-add NET_RAW).
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY probe/package.json probe/
RUN pnpm install --frozen-lockfile --filter @app/probe...
COPY packages/shared packages/shared
COPY probe probe
RUN pnpm --filter @app/shared build && pnpm --filter @app/probe build \
  && pnpm --filter @app/probe deploy --prod --legacy /out \
  && cp -r probe/dist /out/dist

FROM node:24-alpine
# tracepath traces the path to a failing target without special rights (network diagnostics).
RUN apk add --no-cache iputils-ping iputils-tracepath
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/main.js"]
