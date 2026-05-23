# Enterprise Agent Platform

This is an enterprise platform layer for the local `hermes-agent` and `cognee` repositories in this workspace. The platform owns the default Hermes and Cognee runtime setup: it prepares the Hermes profile, installs/enables the enterprise knowledge plugin, starts the Hermes API server, and points Cognee at platform-managed local storage.

It provides:

- Account/password login with signed HttpOnly sessions.
- Channel-based web chat. Each channel routes to one shared main Hermes agent thread.
- Per-user private agents. The platform creates an isolated workspace and, when Docker is available, starts a managed container for the user.
- Central model/API key configuration. Users never enter model keys in their private agent session.
- Enterprise knowledge base with document ingestion, search, passive per-turn suggestions, optional Cognee hybrid indexing, and Hermes tools.
- Built-in runtime management for Hermes and Cognee from the web settings screen.

## Run

```bash
cd ..
./deploy.sh
```

Open `http://127.0.0.1:8765`. The deploy script initializes submodules, creates the root `.venv`, installs this platform package, prepares runtime state, and starts the app. If user-level systemd is available it installs and starts `enterprise-agent-platform.service`; otherwise it runs in the foreground.

If `ENTERPRISE_ADMIN_PASSWORD` is not set before first run, the bootstrap account is `admin` / `admin`.

Useful deployment commands:

```bash
./deploy.sh service      # force user-level systemd install/start
./deploy.sh foreground  # force foreground server
./deploy.sh status
./deploy.sh restart
./deploy.sh logs
```

## Managed Hermes

No separate Hermes install/setup step is required. The top-level deploy script initializes the adjacent `hermes-agent` repository, and on platform startup it will:

- create a managed Hermes home under `data/runtimes/hermes`;
- create `data/runtimes/hermes/venv` and install Hermes from the adjacent `../hermes-agent` source with `pip install -e`;
- install and enable the `enterprise-kb` plugin;
- generate an API server key if one is not already configured;
- start the Hermes gateway with `API_SERVER_ENABLED=true` from the managed venv;
- expose install, configuration, status, and restart controls in Settings.

The Settings screen can update the Hermes source path, API URL, model name, install extras, startup wait, and API server key. Changing install extras or source path causes the next managed prepare/install action to refresh the venv.

The platform sends:

- `X-Hermes-Session-Id: enterprise-channel-<id>-main-agent` for shared channel bot threads.
- `X-Hermes-Session-Id: enterprise-private-u<user_id>` for private agents.
- `X-Hermes-Session-Key` for long-term memory scoping.

Set `ENTERPRISE_MANAGE_HERMES=0` only if you intentionally want to run an external Hermes API server yourself.

## Knowledge Tools For Hermes

The platform keeps a local SQLite/FTS index for fast UI reads and deterministic operation. Set `ENTERPRISE_KB_BACKEND=hybrid` (default) to also attempt ingestion/search through the local `cognee` repository, or `ENTERPRISE_KB_BACKEND=local` to skip Cognee during development. Cognee data, system files, cache, and logs are rooted under `data/runtimes/cognee` by default.

The managed Hermes plugin exposes:

- `enterprise_kb_search(query, limit)`
- `enterprise_kb_read(document_id)`

## Container Behavior

`ENTERPRISE_CONTAINER_BACKEND=auto` is the default. It uses Docker if `docker info` succeeds; otherwise it creates a local workspace under `data/workspaces/user-<id>`.

Useful settings:

```bash
export ENTERPRISE_CONTAINER_BACKEND=docker
export ENTERPRISE_CONTAINER_IMAGE=python:3.11-slim
```

## Tests

```bash
cd ..
./deploy.sh test
```
