# Generated from docs/contracts/upstream-sources.json by scripts/docs_sync.py; do not edit.
from __future__ import annotations

UPSTREAM_SOURCE_SCHEMA_VERSION = 1

UPSTREAM_SOURCES = {
    "cognee": {
        "repository_url": "https://github.com/topoteretes/cognee.git",
        "required_paths": [
            "pyproject.toml",
            "cognee/__init__.py"
        ],
        "revision": "252f2c3efb184533a0955e31e83a28ea7db9813d"
    },
    "firecrawl": {
        "compose_services": [
            "api",
            "foundationdb",
            "foundationdb-init",
            "nuq-postgres",
            "playwright-service",
            "rabbitmq",
            "redis"
        ],
        "repository_url": "https://github.com/firecrawl/firecrawl.git",
        "required_paths": [
            "docker-compose.yaml"
        ],
        "revision": "9b8225fac843a5f3832a68d7e26024fd4844bd94"
    }
}
