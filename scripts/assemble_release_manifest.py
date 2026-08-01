#!/usr/bin/env python3
"""Assemble the stage-bound immutable release manifest.

The transition contract is canonical.  Bridge is the only stage that may bind
the one-time source handoff and helper image.  Cleanup and later target-only
baselines use schema/protocol 2 and cannot carry either source artifact.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from pathlib import Path
from typing import Any

from docs_sync import DocsSyncError, read_strict_json, validate_release_transition_contract


COMMIT = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
IMAGE = re.compile(r"^[^@\s]+@sha256:[0-9a-f]{64}$")
RFC3339 = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$"
)
ORDINARY_KEYS = {
    "schema_version",
    "channel",
    "source_commit",
    "generated_at",
    "protocol_version",
    "database_schema_version",
    "manager",
    "compose",
    "images",
}
MANAGED_V1 = {
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
    "handoff-fs-helper",
}
MANAGED_V2 = MANAGED_V1 - {"handoff-fs-helper"}


class ManifestAssemblyError(ValueError):
    pass


def _fail(message: str) -> None:
    raise ManifestAssemblyError(message)


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail(f"{label} must be an object")
    return value


def _artifact(url: str, sha256: str, label: str) -> dict[str, str]:
    if not url.startswith("https://") or SHA256.fullmatch(sha256) is None:
        _fail(f"{label} is not a complete HTTPS/SHA-256 artifact")
    return {"url": url, "sha256": sha256}


def _manager(
    version: str,
    amd64_url: str,
    amd64_sha256: str,
    arm64_url: str,
    arm64_sha256: str,
) -> dict[str, Any]:
    if COMMIT.fullmatch(version) is None:
        _fail("Manager version must equal a full candidate generation")
    return {
        "version": version,
        "artifacts": {
            "amd64": _artifact(amd64_url, amd64_sha256, "amd64 Manager"),
            "arm64": _artifact(arm64_url, arm64_sha256, "arm64 Manager"),
        },
    }


def normalize_generated_at(value: str) -> str:
    if RFC3339.fullmatch(value) is None:
        _fail("generated_at must be RFC3339 with an explicit timezone")
    try:
        parsed = dt.datetime.fromisoformat(value.removesuffix("Z") + ("+00:00" if value.endswith("Z") else ""))
    except ValueError as exc:
        raise ManifestAssemblyError("generated_at must be a valid RFC3339 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        _fail("generated_at must include an offset")
    return parsed.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _validate_source_manifest(
    value: Any, predecessor: str, source_profile: str
) -> dict[str, Any]:
    source = _object(value, "predecessor manifest")
    if set(source) != ORDINARY_KEYS:
        _fail("bridge predecessor must retain the exact ordinary manifest shape")
    if (
        source.get("schema_version") != 1
        or source.get("channel") != "main"
        or source.get("protocol_version") != 1
        or source.get("source_commit") != predecessor
    ):
        _fail("bridge predecessor manifest identity does not match the contract")
    manager = _object(source.get("manager"), "predecessor Manager")
    compose = _object(source.get("compose"), "predecessor Compose")
    if manager.get("version") != predecessor:
        _fail("bridge predecessor Manager version is not the predecessor generation")
    if source_profile != "ubitech-agent-v1":
        _fail("bridge source profile is not the canonical source identity")
    # The runtime parser performs the full artifact validation.  Requiring the
    # exact closed subobjects here prevents accidental projection or URL
    # reconstruction while assembling the signed descriptor.
    if set(manager) != {"version", "artifacts"} or set(compose) != {"url", "sha256"}:
        _fail("bridge predecessor artifacts are not closed objects")
    return {"profile_id": source_profile, "manager": manager, "compose": compose}


def assemble(args: argparse.Namespace) -> dict[str, Any]:
    try:
        contract = validate_release_transition_contract(
            read_strict_json(args.contract, "release-transition contract"),
            "release-transition contract",
        )
    except DocsSyncError as exc:
        raise ManifestAssemblyError(str(exc)) from exc
    stage = contract["stage"]
    generation = args.generation
    if COMMIT.fullmatch(generation) is None:
        _fail("generation must be a full lowercase commit")
    generated_at = normalize_generated_at(args.generated_at)
    if args.database_schema_version < 1:
        _fail("database schema version must be positive")
    images = _object(
        read_strict_json(args.images, "verified managed images"),
        "verified managed images",
    )
    expected_images = MANAGED_V1 if stage == "bridge" else MANAGED_V2
    if set(images) != expected_images or any(
        not isinstance(value, str) or IMAGE.fullmatch(value) is None
        for value in images.values()
    ):
        _fail(
            f"{stage} images must be the exact "
            f"schema-{'v1' if stage == 'bridge' else 'v2'} managed digest set"
        )

    target_manager = _manager(
        generation,
        args.manager_amd64_url,
        args.manager_amd64_sha256,
        args.manager_arm64_url,
        args.manager_arm64_sha256,
    )
    target_compose = _artifact(args.compose_url, args.compose_sha256, "target Compose")
    manifest = {
        "schema_version": (
            contract["manifest_protocol"]["bridge_schema_version"]
            if stage == "bridge"
            else contract["manifest_protocol"]["cleanup_schema_version"]
        ),
        "channel": "main",
        "source_commit": generation,
        "generated_at": generated_at,
        "protocol_version": 1 if stage == "bridge" else 2,
        "database_schema_version": args.database_schema_version,
        "manager": target_manager,
        "compose": target_compose,
        "images": images,
    }
    if stage != "bridge":
        if args.predecessor_manifest is not None:
            _fail(f"{stage} assembly must not consume a source predecessor manifest")
        return manifest

    if args.predecessor_manifest is None:
        _fail("bridge assembly requires the exact predecessor manifest")
    predecessor = contract["predecessor_generation"]
    source = _validate_source_manifest(
        read_strict_json(args.predecessor_manifest, "predecessor manifest"),
        predecessor,
        contract["source_profile_id"],
    )
    target = {
        "profile_id": contract["target_profile_id"],
        "manager": target_manager,
        "compose": target_compose,
    }
    manifest["namespace_handoff"] = {
        "schema_version": 1,
        "predecessor_generation": predecessor,
        "bridge_generation": generation,
        "source": source,
        "target": target,
    }
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("--predecessor-manifest", type=Path)
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
