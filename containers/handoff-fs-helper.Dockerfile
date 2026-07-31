# syntax=docker/dockerfile:1.7

FROM golang:1.23-bookworm AS build
WORKDIR /src/manager
COPY manager/go.mod manager/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY manager/ ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w -buildid=' \
      -o /out/handoff-fs-helper ./cmd/handoff-fs-helper

FROM scratch
ARG SOURCE_COMMIT=unknown
ARG RELEASE_VERSION=development
LABEL org.opencontainers.image.title="Agent Platform Handoff Filesystem Helper" \
      org.opencontainers.image.source="https://github.com/Noyv3x/enterprise-agent-platform" \
      org.opencontainers.image.revision="$SOURCE_COMMIT" \
      org.opencontainers.image.version="$RELEASE_VERSION"
COPY --from=build /out/handoff-fs-helper /handoff-fs-helper
USER 0:0
ENTRYPOINT ["/handoff-fs-helper"]
