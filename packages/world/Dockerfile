ARG NODE_IMAGE=node:22-bookworm-slim
ARG RUST_IMAGE=rust:1.90-slim-bookworm

FROM ${NODE_IMAGE} AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS dependencies
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
    npm ci --omit=dev --workspace @42tr/3dbox4agent-world

FROM ${RUST_IMAGE} AS native-build
WORKDIR /build
ARG TARGETARCH
COPY packages/world/native/physics ./physics
COPY scripts/collect-native-licenses.sh ./collect-native-licenses.sh
RUN --mount=type=cache,id=3dbox-cargo-registry,target=/var/cache/box-cargo,sharing=locked \
    --mount=type=cache,id=3dbox-cargo-target-${TARGETARCH},target=/build/physics/target,sharing=locked \
    CARGO_HOME=/var/cache/box-cargo cargo build --release --locked --jobs 1 --manifest-path physics/Cargo.toml \
    && cp physics/target/release/libbox_physics.so /build/box_physics.node \
    && CARGO_HOME=/var/cache/box-cargo sh ./collect-native-licenses.sh /build/native-licenses /build/physics/Cargo.lock \
    && test -s /build/native-licenses/rapier3d-0.22.0/LICENSE

FROM base AS world
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY packages/control ./packages/control
COPY packages/world ./packages/world
COPY src ./src
COPY server ./server
COPY third_party ./third_party
COPY examples ./examples
RUN ln -s packages/control/proto proto \
    && mkdir -p /app/.3dbox && chown node:node /app/.3dbox && chmod 700 /app/.3dbox
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    WORLD_BIND=0.0.0.0 \
    WORLD_PORT=8787 \
    BOX_WORLD_API_ONLY=1 \
    BOX_EVENT_JOURNAL_DIR=/app/.3dbox/event-journals \
    BOX_REPLAY_JOURNAL=1
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.WORLD_PORT||8787)+'/health',{signal:AbortSignal.timeout(3000)}).then(async r=>{if(!r.ok||(await r.json()).ok!==true)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "packages/world/server/world-supervisor.js"]

# Native modules are built for the container architecture, never copied from the host.
FROM world AS world-rust
COPY --from=native-build /build/box_physics.node ./packages/world/native/physics/target/release/box_physics.node
COPY --from=native-build /build/native-licenses ./third_party/native
ENV BOX_PHYSICS_BACKEND=rust BOX_TASK_BACKEND=rust BOX_COMM_BACKEND=rust BOX_NAV_BACKEND=rust
