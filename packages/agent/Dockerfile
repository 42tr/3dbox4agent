ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS node-dependencies
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
    npm ci --omit=dev --workspace @42tr/3dbox4agent-agent --workspace @42tr/3dbox4agent-world

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

FROM base
COPY --from=python-build /opt/box-agent /opt/box-agent
COPY --from=node-dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY server ./server
COPY scripts ./scripts
COPY examples ./examples
COPY packages/agent ./packages/agent
COPY packages/world/package.json ./packages/world/package.json
COPY packages/world/src ./packages/world/src
COPY packages/world/scenes ./packages/world/scenes
COPY packages/world/scripts/parse-scene-stdin.js packages/world/scripts/validate-scheduled-plan-stdin.js ./packages/world/scripts/
COPY packages/control ./packages/control
COPY packages/control-server/gateways ./packages/control-server/gateways
COPY sdk/python ./sdk/python
RUN ln -s packages/control/proto proto
ENV PATH="/opt/box-agent/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
USER node
ENTRYPOINT ["python3", "packages/agent/python/multi_agent_demo.py"]
CMD ["--fault", "none", "--physics", "rapier", "--archive"]
