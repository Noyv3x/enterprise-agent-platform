# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS runtime-build
WORKDIR /build/agent-runtime
ENV CI=1 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false
COPY enterprise-agent-platform/agent-runtime/package.json enterprise-agent-platform/agent-runtime/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY enterprise-agent-platform/agent-runtime/tsconfig.json ./
COPY enterprise-agent-platform/agent-runtime/src ./src
RUN npm run build \
    && npm prune --omit=dev

FROM node:24-bookworm-slim AS agent-runtime
ARG SOURCE_COMMIT=unknown
ARG RELEASE_VERSION=development
LABEL org.opencontainers.image.title="Agent Platform Runtime" \
      org.opencontainers.image.source="https://github.com/Noyv3x/enterprise-agent-platform" \
      org.opencontainers.image.revision="$SOURCE_COMMIT" \
      org.opencontainers.image.version="$RELEASE_VERSION"
ENV NODE_ENV=production \
    AGENT_PLATFORM_TECHNICAL_PROFILE=agent-platform-v1 \
    HOME=/var/lib/agent-platform/runtime/home \
    AGENT_RUNTIME_HOME=/var/lib/agent-platform/runtime \
    AGENT_RUNTIME_HOST=0.0.0.0 \
    AGENT_RUNTIME_PORT=8766 \
    AGENT_RUNTIME_MAX_BODY_BYTES=33554432 \
    AGENT_PLATFORM_INTERNAL_URL=http://platform:8765
RUN install -d -o node -g node -m 0700 /var/lib/agent-platform/runtime
WORKDIR /opt/agent-platform-runtime
COPY --from=runtime-build /build/agent-runtime/package.json ./
COPY --from=runtime-build /build/agent-runtime/node_modules ./node_modules
COPY --from=runtime-build /build/agent-runtime/dist ./dist
COPY containers/agent-runtime-entrypoint.sh /usr/local/bin/agent-runtime-entrypoint
RUN chmod 0755 /usr/local/bin/agent-runtime-entrypoint
USER node
EXPOSE 8766
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=12 \
  CMD node -e 'const fs=require("fs");const t=process.env.AGENT_RUNTIME_TOKEN||fs.readFileSync(process.env.AGENT_RUNTIME_TOKEN_FILE,"utf8").trim();fetch("http://127.0.0.1:8766/health",{headers:{authorization:`Bearer ${t}`}}).then(async r=>process.exit(r.ok&&(await r.json()).service==="agent-platform-runtime"?0:1)).catch(()=>process.exit(1))'
ENTRYPOINT ["/usr/local/bin/agent-runtime-entrypoint"]
CMD ["node", "dist/src/server.js"]
