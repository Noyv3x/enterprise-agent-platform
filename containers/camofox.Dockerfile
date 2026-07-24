# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS camofox-build
ARG TARGETARCH
ENV CI=1 \
    CAMOFOX_SKIP_DOWNLOAD=1 \
    CAMOFOX_CRASH_REPORT_ENABLED=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/camofox
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) asset='camoufox-150.0.2-alpha.26-lin.x86_64.zip'; expected='b146b98b0c2c41023716feef36451f319a534309f72c54584a4b0b88670f510b'; size='661687098' ;; \
      arm64) asset='camoufox-150.0.2-alpha.25-lin.arm64.zip'; expected='b2870af8cd99721d41bd48f0cce0f949449ab75364b80ee3d389bd35953ea213'; size='652036669' ;; \
      *) echo "unsupported Camoufox architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl --fail --location --retry 5 --retry-all-errors \
      --output /tmp/camoufox.zip \
      "https://github.com/daijro/camoufox/releases/download/v150.0.2-beta.25/$asset"; \
    test "$(wc -c < /tmp/camoufox.zip)" = "$size"; \
    echo "$expected  /tmp/camoufox.zip" | sha256sum -c -; \
    mkdir -p browser; \
    unzip -q /tmp/camoufox.zip -d browser; \
    rm /tmp/camoufox.zip; \
    test -x browser/camoufox; \
    test -x browser/camoufox-bin; \
    test -f browser/libxul.so
RUN set -eu; \
    test -f browser/properties.json; \
    test -d browser/fontconfig; \
    printf '{\n  "release": "beta.25",\n  "version": "150.0.2"\n}\n' > browser/version.json
COPY enterprise-agent-platform/camofox-runtime/package.json enterprise-agent-platform/camofox-runtime/package-lock.json ./
COPY enterprise-agent-platform/camofox-runtime/loopback-preload.cjs enterprise-agent-platform/camofox-runtime/patch-runtime.cjs ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev \
    && node patch-runtime.cjs \
    && grep -Fq 'reporter.resetNativeMemBaseline?.();' node_modules/@askjo/camofox-browser/server.js

FROM node:24-bookworm-slim AS camofox
ARG SOURCE_COMMIT=unknown
ARG RELEASE_VERSION=development
LABEL org.opencontainers.image.title="ubitech Camoufox browser" \
      org.opencontainers.image.source="https://github.com/Noyv3x/enterprise-agent-platform" \
      org.opencontainers.image.revision="$SOURCE_COMMIT" \
      org.opencontainers.image.version="$RELEASE_VERSION"
ENV NODE_ENV=production \
    HOME=/var/lib/ubitech-agent/camofox/home \
    CAMOFOX_PORT=9377 \
    HOST=0.0.0.0 \
    CAMOFOX_HOST=0.0.0.0 \
    UBITECH_CAMOFOX_BIND_HOST=0.0.0.0 \
    CAMOFOX_PROFILE_DIR=/var/lib/ubitech-agent/camofox/profiles \
    CAMOFOX_COOKIES_DIR=/var/lib/ubitech-agent/camofox/cookies \
    CAMOFOX_TRACES_DIR=/var/lib/ubitech-agent/camofox/traces \
    XDG_CACHE_HOME=/var/lib/ubitech-agent/camofox/home/.cache \
    CAMOFOX_CRASH_REPORT_ENABLED=false \
    CAMOUFOX_EXECUTABLE_PATH=/opt/camofox/browser/camoufox \
    CAMOFOX_EXECUTABLE_PATH=/opt/camofox/browser/camoufox \
    LD_LIBRARY_PATH=/opt/camofox/browser
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates fontconfig fonts-liberation fonts-noto-color-emoji \
      libasound2 libdbus-glib-1-2 libegl1 libgbm1 libgl1-mesa-dri libgtk-3-0 \
      libx11-xcb1 libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 \
      libxrandr2 libxrender1 libxss1 libxt6 libxtst6 xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node -m 0700 /var/lib/ubitech-agent/camofox
WORKDIR /opt/camofox
COPY --from=camofox-build --chown=1000:1000 /opt/camofox /opt/camofox
COPY containers/camofox-entrypoint.sh /usr/local/bin/ubitech-camofox-entrypoint
RUN chmod 0755 /usr/local/bin/ubitech-camofox-entrypoint
USER node
EXPOSE 9377
HEALTHCHECK --interval=10s --timeout=3s --start-period=45s --retries=18 \
  CMD node -e 'fetch("http://127.0.0.1:9377/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
ENTRYPOINT ["/usr/local/bin/ubitech-camofox-entrypoint"]
CMD ["node", "--require", "/opt/camofox/loopback-preload.cjs", "/opt/camofox/node_modules/@askjo/camofox-browser/server.js"]
