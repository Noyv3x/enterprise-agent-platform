# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS agent-sandbox
ARG SOURCE_COMMIT=unknown
ARG RELEASE_VERSION=development
LABEL org.opencontainers.image.title="Agent Platform Sandbox" \
      org.opencontainers.image.source="https://github.com/Noyv3x/enterprise-agent-platform" \
      org.opencontainers.image.revision="$SOURCE_COMMIT" \
      org.opencontainers.image.version="$RELEASE_VERSION" \
      io.agent-platform.role="sandbox" \
      io.agent-platform.profile="agent-platform-v1"
ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/home/agent \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    AGENT_PLATFORM_TECHNICAL_PROFILE=agent-platform-v1 \
    AGENT_PLATFORM_AGENT_UID=1000 \
    AGENT_PLATFORM_AGENT_GID=1000
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash build-essential ca-certificates curl file git jq less openssh-client \
      procps python3 python3-pip python3-venv ripgrep sudo tini unzip util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && groupmod --new-name agent node \
    && usermod --login agent --home /home/agent --move-home node \
    && printf 'agent ALL=(ALL:ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/agent-platform \
    && chmod 0440 /etc/sudoers.d/agent-platform \
    && install -d -o 1000 -g 1000 -m 0700 /workspace /opt/agent-env
COPY containers/agent-sandbox-entrypoint.sh /usr/local/bin/agent-sandbox-entrypoint
RUN chmod 0755 /usr/local/bin/agent-sandbox-entrypoint
USER root
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/agent-sandbox-entrypoint"]
CMD ["sleep", "infinity"]
