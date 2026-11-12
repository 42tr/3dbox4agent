ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS web-build
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV NPM_CONFIG_REGISTRY=${NPM_REGISTRY} \
    NPM_CONFIG_REPLACE_REGISTRY_HOST=always \
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false
COPY package.json package-lock.json ./
COPY packages/agent/package.json ./packages/agent/package.json
COPY packages/console/package.json ./packages/console/package.json
COPY packages/control/package.json ./packages/control/package.json
COPY packages/world/package.json ./packages/world/package.json
RUN --mount=type=cache,id=3dbox-npm-downloads,target=/root/.npm,sharing=locked \
    npm ci --workspace @42tr/3dbox4agent-console
COPY packages/console ./packages/console
COPY packages/control ./packages/control
COPY packages/world ./packages/world
COPY examples ./examples
RUN npm run build

FROM ${NODE_IMAGE}
WORKDIR /app
COPY packages/control/package.json ./node_modules/@42tr/3dbox4agent-control/package.json
COPY packages/control/src ./node_modules/@42tr/3dbox4agent-control/src
COPY packages/console/server ./server
COPY --from=web-build /app/packages/console/dist ./dist
ENV CONSOLE_BIND=0.0.0.0 CONSOLE_PORT=8787
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.CONSOLE_PORT||8787)+'/health',{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server/console-server.js"]
