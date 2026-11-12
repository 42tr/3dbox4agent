ARG RUST_IMAGE=rust:1.90-slim-bookworm
ARG RUNTIME_IMAGE=debian:bookworm-slim

FROM ${RUST_IMAGE} AS control-build
WORKDIR /build
ARG TARGETARCH
COPY packages/control-server/Cargo.toml packages/control-server/Cargo.lock ./control-server/
COPY packages/control-server/src ./control-server/src
COPY scripts/collect-native-licenses.sh ./collect-native-licenses.sh
RUN --mount=type=cache,id=3dbox-control-cargo-registry,target=/var/cache/box-cargo,sharing=locked \
    --mount=type=cache,id=3dbox-control-cargo-target-${TARGETARCH},target=/build/control-server/target,sharing=locked \
    CARGO_HOME=/var/cache/box-cargo cargo build --release --locked --jobs 1 --manifest-path control-server/Cargo.toml \
    && cp control-server/target/release/threebox-control-server /build/threebox-control-server \
    && CARGO_HOME=/var/cache/box-cargo sh ./collect-native-licenses.sh /build/control-licenses /build/control-server/Cargo.lock

FROM ${RUNTIME_IMAGE}
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=control-build /build/threebox-control-server /usr/local/bin/threebox-control-server
COPY --from=control-build /build/control-licenses /usr/share/doc/threebox-control-server/crates
ENV CONTROL_BIND=0.0.0.0:8789
USER 65534:65534
EXPOSE 8789
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
    CMD ["curl", "-fsS", "--max-time", "3", "http://127.0.0.1:8789/world/health"]
CMD ["/usr/local/bin/threebox-control-server"]
