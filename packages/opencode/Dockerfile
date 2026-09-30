FROM alpine AS base

# Disable the runtime transpiler cache by default inside Docker containers.
# On ephemeral containers, the cache is not useful
ARG BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=${BUN_RUNTIME_TRANSPILER_CACHE_PATH}
RUN apk add libgcc libstdc++ ripgrep

FROM base AS build-amd64
COPY dist/openfork-linux-x64-baseline-musl/bin/openfork /usr/local/bin/openfork
COPY dist/openfork-linux-x64-baseline-musl/bin/openfork-t3code /usr/local/bin/openfork-t3code
COPY dist/openfork-linux-x64-baseline-musl/bin/opencode /usr/local/bin/opencode

FROM base AS build-arm64
COPY dist/openfork-linux-arm64-musl/bin/openfork /usr/local/bin/openfork
COPY dist/openfork-linux-arm64-musl/bin/openfork-t3code /usr/local/bin/openfork-t3code
COPY dist/openfork-linux-arm64-musl/bin/opencode /usr/local/bin/opencode

ARG TARGETARCH
FROM build-${TARGETARCH}
RUN openfork --version \
    && test "$(openfork-t3code --version)" = "1.15.13" \
    && test "$(opencode --version)" = "$(openfork --version)"
ENTRYPOINT ["openfork"]
