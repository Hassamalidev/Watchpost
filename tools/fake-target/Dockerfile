# Dev-only outage simulator. Build context is the repo root.
FROM node:24-alpine
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY tools/fake-target/package.json tools/fake-target/
RUN pnpm install --frozen-lockfile --filter @app/fake-target
COPY tools/fake-target tools/fake-target
RUN pnpm --filter @app/fake-target build
WORKDIR /repo/tools/fake-target
ENV NODE_ENV=production
USER node
EXPOSE 4100 4101 4102
CMD ["node", "dist/main.js"]
