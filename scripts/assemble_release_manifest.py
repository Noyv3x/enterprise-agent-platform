#!/usr/bin/env python3
"""Assemble the single target-only main-channel release manifest."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from pathlib import Path
from typing import Any, NoReturn
from urllib.parse import urlsplit

from docs_sync import DocsSyncError, read_strict_json


COMMIT = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
IMAGE = re.compile(r"^[^@\s]+@sha256:[0-9a-f]{64}$")
RFC3339 = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$"
)
MANAGED_IMAGES = {
    "platform",
    "agent-runtime",
    "camofox",
    "agent-sandbox",
    "searxng",
    "firecrawl-api",
    "firecrawl-playwright",
    "firecrawl-postgres",
    "firecrawl-redis",
    "firecrawl-rabbitmq",
}


class ManifestAssemblyError(ValueError):
    pass


def _fail(message: str) -> NoReturn:
    raise ManifestAssemblyError(message)


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail(f"{label} must be an object")
    return value


def _artifact(url: str, sha256: str, basename: str, label: str) -> dict[str, str]:
    try:
        parsed = urlsplit(url)
        hostname = parsed.hostname
    except (TypeError, ValueError):
        _fail(f"{label} is not a canonical HTTPS/SHA-256 artifact")
    if (
        parsed.scheme != "https"
        or hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or Path(parsed.path).name != basename
        or SHA256.fullmatch(sha256) is None
    ):
        _fail(f"{label} is not a canonical HTTPS/SHA-256 artifact")
    return {"url": url, "sha256": sha256}


def normalize_generated_at(value: str) -> str:
    if RFC3339.fullmatch(value) is None:
        _fail("generated_at must be RFC3339 with an explicit timezone")
    try:
        parsed = dt.datetime.fromisoformat(
            value.removesuffix("Z") + ("+00:00" if value.endswith("Z") else "")
        )
    except ValueError as exc:
        raise ManifestAssemblyError(
            "generated_at must be a valid RFC3339 timestamp"
        ) from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        _fail("generated_at must include an offset")
    return parsed.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def assemble(args: argparse.Namespace) -> dict[str, Any]:
    generation = args.generation
    if COMMIT.fullmatch(generation) is None:
        _fail("generation must be a full lowercase commit")
    if args.database_schema_version < 1:
        _fail("database schema version must be positive")
    images = _object(
        read_strict_json(args.images, "verified managed images"),
        "verified managed images",
    )
    if set(images) != MANAGED_IMAGES or any(
        not isinstance(value, str) or IMAGE.fullmatch(value) is None
        for value in images.values()
    ):
        _fail("images must be the exact ten-image immutable digest set")

    artifacts = {
        architecture: _artifact(
            url,
            sha256,
            f"agent-platform-manager-linux-{architecture}",
            f"{architecture} Manager",
        )
        for architecture, url, sha256 in (
            ("amd64", args.manager_amd64_url, args.manager_amd64_sha256),
            ("arm64", args.manager_arm64_url, args.manager_arm64_sha256),
        )
    }
    return {
        "schema_version": 2,
        "channel": "main",
        "source_commit": generation,
        "generated_at": normalize_generated_at(args.generated_at),
        "protocol_version": 2,
        "database_schema_version": args.database_schema_version,
        "manager": {"version": generation, "artifacts": artifacts},
        "compose": _artifact(
            args.compose_url,
            args.compose_sha256,
            "agent-platform-compose.yaml",
            "Compose",
        ),
        "images": images,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--generation", required=True)
    parser.add_argument("--generated-at", required=True)
    parser.add_argument("--database-schema-version", type=int, required=True)
    parser.add_argument("--manager-amd64-url", required=True)
    parser.add_argument("--manager-amd64-sha256", required=True)
    parser.add_argument("--manager-arm64-url", required=True)
    parser.add_argument("--manager-arm64-sha256", required=True)
    parser.add_argument("--compose-url", required=True)
    parser.add_argument("--compose-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        manifest = assemble(args)
    except (ManifestAssemblyError, DocsSyncError) as exc:
        print(str(exc), file=__import__("sys").stderr)
        return 1
    args.output.write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
