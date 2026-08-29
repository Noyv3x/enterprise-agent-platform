# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS frontend-build
WORKDIR /build/enterprise-agent-platform
ENV CI=1 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false
COPY enterprise-agent-platform/frontend/package.json enterprise-agent-platform/frontend/package-lock.json ./frontend/
RUN --mount=type=cache,target=/root/.npm \
    cd frontend && npm ci
COPY enterprise-agent-platform/frontend ./frontend
RUN cd frontend && npm run build

FROM python:3.11-slim-bookworm AS python-build
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    VIRTUAL_ENV=/opt/venv
RUN python -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
RUN python -m pip install --upgrade pip setuptools wheel
WORKDIR /build/enterprise-agent-platform
COPY enterprise-agent-platform/pyproject.toml enterprise-agent-platform/README.md ./
COPY enterprise-agent-platform/enterprise_agent_platform ./enterprise_agent_platform
COPY --from=frontend-build /build/enterprise-agent-platform/enterprise_agent_platform/static ./enterprise_agent_platform/static
RUN python -m pip install . \
    && python -m compileall -q "$VIRTUAL_ENV/lib/python3.11/site-packages/enterprise_agent_platform"

FROM python:3.11-slim-bookworm AS platform
ENV PATH="/opt/venv/bin:$PATH" \
    HOME=/var/lib/agent-platform/.home \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    AGENT_PLATFORM_TECHNICAL_PROFILE=agent-platform-v1 \
    AGENT_PLATFORM_DATA=/var/lib/agent-platform \
    AGENT_PLATFORM_HOST=0.0.0.0 \
    AGENT_PLATFORM_PORT=8765 \
    AGENT_PLATFORM_AGENT_RUNTIME_URL=http://agent-runtime:8766 \
    AGENT_PLATFORM_CAMOFOX_URL=http://camofox:9377 \
    AGENT_PLATFORM_SEARXNG_API_URL=http://searxng:8080 \
    AGENT_PLATFORM_FIRECRAWL_API_URL=http://firecrawl-api:3002 \
    AGENT_PLATFORM_DEPLOYMENT_MODE=container
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libmagic1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 agent-platform \
    && useradd --uid 1000 --gid 1000 --create-home --shell /usr/sbin/nologin agent-platform \
    && install -d -o 1000 -g 1000 -m 0700 /var/lib/agent-platform
COPY --from=python-build /opt/venv /opt/venv
COPY containers/platform-entrypoint.sh /usr/local/bin/agent-platform-entrypoint
RUN chmod 0755 /usr/local/bin/agent-platform-entrypoint
ARG SOURCE_COMMIT=unknown
ARG RELEASE_VERSION=development
LABEL org.opencontainers.image.title="Agent Platform" \
      org.opencontainers.image.source="https://github.com/Noyv3x/enterprise-agent-platform" \
      org.opencontainers.image.revision="$SOURCE_COMMIT" \
      org.opencontainers.image.version="$RELEASE_VERSION"
USER 1000:1000
WORKDIR /var/lib/agent-platform
EXPOSE 8765
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=12 \
  CMD ["/usr/local/bin/agent-platform-entrypoint", "__healthcheck"]
ENTRYPOINT ["/usr/local/bin/agent-platform-entrypoint"]
CMD ["enterprise-agent-platform", "serve", "--host", "0.0.0.0", "--port", "8765", "--data", "/var/lib/agent-platform"]
