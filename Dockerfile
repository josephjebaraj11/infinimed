# InfiniMed: API, worker and dashboard in one image. The same image runs as the API
# (default command) or as a dedicated worker (`pnpm --filter @infinimed/server worker`).
FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/sdk/package.json packages/sdk/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @infinimed/dashboard build && pnpm --filter @infinimed/sdk build

FROM node:24.22.1-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate && useradd --system --uid 10001 infinimed
COPY --from=build --chown=infinimed /app /app
USER infinimed
WORKDIR /app/apps/server
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/index.ts"]
