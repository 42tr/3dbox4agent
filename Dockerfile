ARG NODE_IMAGE=node:22-bookworm-slim
ARG RUST_IMAGE=rust:1.90-slim-bookworm

FROM ${NODE_IMAGE} AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS web-build
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV NPM_CONFIG_REGISTRY=${NPM_REGISTRY} \
    NPM_CONFIG_REPLACE_REGISTRY_HOST=always \
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=3dbox-npm-downloads,target=/root/.npm,sharing=locked \
    npm ci
COPY build.py ./
COPY src ./src
COPY packages/console ./packages/console
COPY packages/world ./packages/world
COPY examples ./examples
COPY assets/mission-control ./assets/mission-control
RUN npm run build && npm prune --omit=dev

FROM base AS python-dependencies
ARG TARGETARCH
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_DISABLE_PIP_VERSION_CHECK=1
COPY sdk/python/pyproject.toml /tmp/box-sdk-pyproject.toml
RUN --mount=type=cache,id=3dbox-python-downloads-${TARGETARCH},target=/root/.cache/pip,sharing=locked \
    python3 -m venv /opt/box-agent \
    && for pip_attempt in 1 2 3; do \
        if /opt/box-agent/bin/python -c "import pathlib,subprocess,tomllib; p=tomllib.loads(pathlib.Path('/tmp/box-sdk-pyproject.toml').read_text()); deps=p['build-system']['requires']+['wheel']+p['project'].get('dependencies',[])+p['project']['optional-dependencies']['grpc-stream']; subprocess.check_call(['/opt/box-agent/bin/python','-m','pip','install','--retries','5','--timeout','180',*deps])"; then \
            break; \
        fi; \
        if [ "$pip_attempt" -eq 3 ]; then exit 1; fi; \
        printf 'Python dependency installation failed (attempt %s/3); retrying in 5 seconds.\n' "$pip_attempt" >&2; \
        sleep 5; \
    done

FROM python-dependencies AS python-build
COPY sdk/python ./sdk/python
RUN /opt/box-agent/bin/pip install --no-index --no-deps --no-build-isolation './sdk/python[grpc-stream]'

FROM ${RUST_IMAGE} AS control-build
WORKDIR /build
ARG TARGETARCH
COPY packages/control-server ./control-server
COPY scripts/collect-native-licenses.sh ./collect-native-licenses.sh
RUN --mount=type=cache,id=3dbox-control-cargo-registry,target=/var/cache/box-cargo,sharing=locked \
    --mount=type=cache,id=3dbox-control-cargo-target-${TARGETARCH},target=/build/control-server/target,sharing=locked \
    CARGO_HOME=/var/cache/box-cargo cargo build --release --locked --jobs 1 --manifest-path control-server/Cargo.toml \
    && cp control-server/target/release/threebox-control-server /build/threebox-control-server \
    && CARGO_HOME=/var/cache/box-cargo sh ./collect-native-licenses.sh /build/control-licenses /build/control-server/Cargo.lock

FROM ${RUST_IMAGE} AS native-build
WORKDIR /build
ARG TARGETARCH
COPY rust/physics ./rust/physics
COPY scripts/collect-native-licenses.sh ./collect-native-licenses.sh
RUN --mount=type=cache,id=3dbox-cargo-registry,target=/var/cache/box-cargo,sharing=locked \
    --mount=type=cache,id=3dbox-cargo-target-${TARGETARCH},target=/build/rust/physics/target,sharing=locked \
    CARGO_HOME=/var/cache/box-cargo cargo build --release --locked --jobs 1 --manifest-path rust/physics/Cargo.toml \
    && cp rust/physics/target/release/libbox_physics.so /build/box_physics.node \
    && CARGO_HOME=/var/cache/box-cargo sh ./collect-native-licenses.sh \
    && test -s /build/native-licenses/rapier3d-0.22.0/LICENSE

# Default Compose target. Compilers and local runtime data stay outside this image.
FROM base AS world
COPY --from=web-build /app/node_modules ./node_modules
COPY --from=web-build /app/index.html ./index.html
COPY --from=python-build /opt/box-agent /opt/box-agent
COPY --from=control-build /build/threebox-control-server /usr/local/bin/threebox-control-server
COPY --from=control-build /build/control-licenses ./third_party/control
COPY package.json package-lock.json ./
COPY src ./src
COPY packages/agent ./packages/agent
COPY packages/console ./packages/console
COPY packages/control ./packages/control
COPY packages/world ./packages/world
COPY server ./server
COPY scripts ./scripts
COPY third_party ./third_party
COPY sdk/python ./sdk/python
COPY proto ./proto
COPY examples ./examples
COPY rust/physics ./rust/physics
RUN mkdir -p /app/.3dbox && chown node:node /app/.3dbox && chmod 700 /app/.3dbox
ENV PATH="/opt/box-agent/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    WORLD_BIND=0.0.0.0 \
    WORLD_PORT=8787 \
    BOX_EVENT_JOURNAL_DIR=/app/.3dbox/event-journals \
    BOX_REPLAY_JOURNAL=1
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.WORLD_PORT||8787)+'/health',{signal:AbortSignal.timeout(3000)}).then(async r=>{if(!r.ok||(await r.json()).ok!==true)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server/world-supervisor.js"]

# Native modules are built for the container architecture, never copied from the host.
FROM world AS world-rust
COPY --from=native-build /build/box_physics.node ./rust/physics/target/release/box_physics.node
COPY --from=native-build /build/native-licenses ./third_party/native
ENV BOX_PHYSICS_BACKEND=rust BOX_TASK_BACKEND=rust BOX_COMM_BACKEND=rust BOX_NAV_BACKEND=rust
