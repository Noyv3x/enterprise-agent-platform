# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS agent-sandbox
ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/home/agent \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    AGENT_PLATFORM_TECHNICAL_PROFILE=agent-platform-v1 \
    AGENT_PLATFORM_AGENT_UID=1000 \
    AGENT_PLATFORM_AGENT_GID=1000
# Keep package resolution stable between releases; update the snapshot deliberately.
ARG DEBIAN_SNAPSHOT=20260929T000000Z
# The base has no CA bundle yet; apt still verifies signed snapshot metadata.
RUN printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s/ bookworm main\ndeb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s/ bookworm-updates main\ndeb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/%s/ bookworm-security main\n' "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list \
    && rm /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      bash build-essential ca-certificates curl file git jq less openssh-client \
      procps python-is-python3 python3 python3-docx python3-lxml python3-openpyxl python3-pil \
      python3-pip python3-pypdf python3-reportlab python3-venv python3-xlsxwriter \
      ripgrep sudo tini unzip util-linux \
    && python3 -m pip install --break-system-packages --no-cache-dir --no-deps \
      python-pptx==0.6.21 \
    && rm -rf /var/lib/apt/lists/* \
    && groupmod --new-name agent node \
    && usermod --login agent --home /home/agent --move-home node \
    && printf 'agent ALL=(ALL:ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/agent-platform \
    && chmod 0440 /etc/sudoers.d/agent-platform \
    && install -d -o 1000 -g 1000 -m 0700 /workspace /opt/agent-env
COPY containers/agent-sandbox-entrypoint.sh /usr/local/bin/agent-sandbox-entrypoint
COPY containers/agent-sandbox-mcp-client.mjs /usr/local/bin/agent-platform-mcp
RUN chmod 0755 /usr/local/bin/agent-sandbox-entrypoint /usr/local/bin/agent-platform-mcp
LABEL org.opencontainers.image.title="Agent Platform Sandbox" \
      org.opencontainers.image.source="https://github.com/Noyv3x/enterprise-agent-platform" \
      io.agent-platform.role="sandbox" \
      io.agent-platform.profile="agent-platform-v1"
USER root
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/agent-sandbox-entrypoint"]
CMD ["sleep", "infinity"]
