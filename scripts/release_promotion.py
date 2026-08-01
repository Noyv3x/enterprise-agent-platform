#!/usr/bin/env python3
"""Build and verify immutable main-channel promotion records.

The Manager release manifest remains a runtime contract.  ``promotion.json``
is a separate CI-only contract that binds a release to the canonical
release-transition plan and deployment-attestation schemas.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import datetime as dt
import hashlib
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Sequence

from docs_sync import (
    DocsSyncError,
    read_strict_json,
    validate_closed_json_schema_instance,
    validate_release_transition_contract,
)


COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_RE = re.compile(r"^[^@\s]+@sha256:[0-9a-f]{64}$")
PROMOTION_KEYS = {
    "schema_version",
    "transition_id",
    "stage",
    "generation",
    "predecessor_generation",
    "source_profile_id",
    "target_profile_id",
    "manifest_schema_version",
    "manifest_sha256",
    "contract_sha256",
    "challenge_schema_sha256",
    "receipt_schema_sha256",
    "required_receipt_type",
    "sealed_assets",
}
SEALED_ASSET_KEYS = {"name", "sha256", "size"}
BRIDGE_SEALED_RELEASE_ASSETS = tuple(
    sorted(
        {
            "install.sh",
            "install.sh.sha256",
            "release.json",
            "ubitech-compose.yaml",
            "ubitech-manager-linux-amd64",
            "ubitech-manager-linux-amd64.sha256",
            "ubitech-manager-linux-arm64",
            "ubitech-manager-linux-arm64.sha256",
        }
    )
)
TARGET_SEALED_RELEASE_ASSETS = tuple(
    sorted(
        {
            "install.sh",
            "install.sh.sha256",
            "release.json",
            "agent-platform-compose.yaml",
            "agent-platform-manager-linux-amd64",
            "agent-platform-manager-linux-amd64.sha256",
            "agent-platform-manager-linux-arm64",
            "agent-platform-manager-linux-arm64.sha256",
        }
    )
)
PUBLISHER_WORKFLOW_PATH = ".github/workflows/container-release.yml"
PUBLISHER_EVENTS = {"workflow_run", "workflow_dispatch"}
PUBLISHER_PROVENANCE_KEYS = {
    "schema_version",
    "repository",
    "workflow_path",
    "workflow_event",
    "workflow_run_id",
    "run_attempt",
    "execution_head_branch",
    "execution_head_sha",
    "source_commit",
    "candidate_stage",
    "source_selection",
    "release",
}
PUBLISHER_STAGES = {"bridge", "cleanup", "target_baseline"}
SOURCE_SELECTION_KEYS = {
    "kind",
    "resolution",
    "requested_ref",
    "qualification_run_id",
    "qualification_run_attempt",
    "qualification_workflow_path",
    "qualification_event",
    "qualification_conclusion",
    "qualification_head_branch",
    "qualification_head_sha",
    "qualification_head_repository",
}
SOURCE_SELECTION_RESOLUTION = {
    "workflow_run": "qualified_workflow_run.head_sha",
    "workflow_dispatch": "checkout(inputs.ref).git_rev_parse_head",
}
RELEASE_IDENTITY_KEYS = {
    "release_id",
    "tag_name",
    "target_commitish",
    "draft",
    "prerelease",
    "assets",
}
RELEASE_IDENTITY_ASSET_KEYS = {"id", "name", "digest", "size", "state"}
REPOSITORY_RE = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$"
)
ORDINARY_MANIFEST_KEYS = {
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
BRIDGE_MANIFEST_KEYS = ORDINARY_MANIFEST_KEYS | {"namespace_handoff"}
STAGE_PREDECESSOR = {
    "bridge": "source_owner",
    "cleanup": "bridge",
}
TARGET_BASELINE_PREDECESSORS = {"cleanup", "target_baseline"}
MANAGED_IMAGES_V1 = {
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
MANAGED_IMAGES_V2 = MANAGED_IMAGES_V1 - {"handoff-fs-helper"}


class PromotionError(RuntimeError):
    pass


def _fail(message: str) -> None:
    raise PromotionError(message)


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail(f"{label} must be a JSON object")
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _require_regular(path: Path, label: str) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError as exc:
        raise PromotionError(f"{label} is missing: {path}") from exc
    if not stat.S_ISREG(info.st_mode) or path.is_symlink():
        _fail(f"{label} must be a regular non-symlink file: {path}")


def _release_assets(stage: str) -> tuple[str, ...]:
    if stage in {"source_owner", "bridge"}:
        return BRIDGE_SEALED_RELEASE_ASSETS
    if stage in {"cleanup", "target_baseline"}:
        return TARGET_SEALED_RELEASE_ASSETS
    _fail(f"unsupported release stage: {stage!r}")


def _all_release_assets(stage: str) -> tuple[str, ...]:
    return tuple(sorted((*_release_assets(stage), "promotion.json")))


def _sealed_assets(root: Path, stage: str) -> list[dict[str, Any]]:
    try:
        info = root.lstat()
    except FileNotFoundError as exc:
        raise PromotionError(f"sealed asset root is missing: {root}") from exc
    if not stat.S_ISDIR(info.st_mode) or root.is_symlink():
        _fail(f"sealed asset root must be a non-symlink directory: {root}")
    assets: list[dict[str, Any]] = []
    for name in _release_assets(stage):
        path = root / name
        _require_regular(path, f"sealed release asset {name}")
        size = path.stat().st_size
        if size <= 0:
            _fail(f"sealed release asset must not be empty: {name}")
        assets.append({"name": name, "sha256": _sha256(path), "size": size})
    return assets


def _validate_sealed_assets(
    value: Any, manifest_sha256: str, stage: str
) -> list[dict[str, Any]]:
    release_assets = _release_assets(stage)
    if not isinstance(value, list) or len(value) != len(release_assets):
        _fail("sealed asset directory must have the exact closed release shape")
    names: list[str] = []
    assets: list[dict[str, Any]] = []
    for item in value:
        asset = _object(item, "sealed release asset")
        if set(asset) != SEALED_ASSET_KEYS:
            _fail("sealed release asset must contain exactly name, sha256, and size")
        name = asset.get("name")
        digest = asset.get("sha256")
        size = asset.get("size")
        if not isinstance(name, str) or name not in release_assets:
            _fail("sealed release asset has an unknown name")
        if not isinstance(digest, str) or SHA256_RE.fullmatch(digest) is None:
            _fail(f"sealed release asset has an invalid digest: {name}")
        if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
            _fail(f"sealed release asset has an invalid size: {name}")
        names.append(name)
        assets.append({"name": name, "sha256": digest, "size": size})
    if names != list(release_assets) or len(set(names)) != len(names):
        _fail("sealed release assets must be unique and sorted by exact name")
    release_asset = next(asset for asset in assets if asset["name"] == "release.json")
    if release_asset["sha256"] != manifest_sha256:
        _fail("sealed release.json does not match the bound manifest")
    return assets


def validate_release_identity(
    value: Any, generation: str, stage: str
) -> dict[str, Any]:
    """Validate the closed GitHub Release identity sealed by a publish attempt."""

    if COMMIT_RE.fullmatch(generation) is None:
        _fail("release identity generation must be a lowercase 40-character commit")
    identity = _object(value, "release identity")
    if set(identity) != RELEASE_IDENTITY_KEYS:
        _fail("release identity must have the exact closed shape")
    release_id = identity.get("release_id")
    if isinstance(release_id, bool) or not isinstance(release_id, int) or release_id <= 0:
        _fail("release identity has an invalid release id")
    if (
        identity.get("tag_name") != f"container-{generation}"
        or identity.get("target_commitish") != generation
        or not isinstance(identity.get("draft"), bool)
        or identity.get("prerelease") is not False
    ):
        _fail("release identity does not match the candidate generation")
    all_release_assets = _all_release_assets(stage)
    raw_assets = identity.get("assets")
    if not isinstance(raw_assets, list) or len(raw_assets) != len(all_release_assets):
        _fail("release identity must contain the exact closed asset set")
    assets: list[dict[str, Any]] = []
    names: list[str] = []
    ids: list[int] = []
    for raw_asset in raw_assets:
        asset = _object(raw_asset, "release identity asset")
        if set(asset) != RELEASE_IDENTITY_ASSET_KEYS:
            _fail("release identity asset must have the exact closed shape")
        asset_id = asset.get("id")
        name = asset.get("name")
        digest = asset.get("digest")
        size = asset.get("size")
        if isinstance(asset_id, bool) or not isinstance(asset_id, int) or asset_id <= 0:
            _fail("release identity asset has an invalid id")
        if not isinstance(name, str) or name not in all_release_assets:
            _fail("release identity asset has an unknown name")
        if not isinstance(digest, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", digest) is None:
            _fail(f"release identity asset has an invalid digest: {name}")
        if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
            _fail(f"release identity asset has an invalid size: {name}")
        if asset.get("state") != "uploaded":
            _fail(f"release identity asset is not uploaded: {name}")
        names.append(name)
        ids.append(asset_id)
        assets.append(
            {
                "id": asset_id,
                "name": name,
                "digest": digest,
                "size": size,
                "state": "uploaded",
            }
        )
    if names != list(all_release_assets) or len(set(names)) != len(names):
        _fail("release identity assets must be unique and sorted by exact name")
    if len(set(ids)) != len(ids):
        _fail("release identity asset ids must be unique")
    return {
        "release_id": release_id,
        "tag_name": identity["tag_name"],
        "target_commitish": identity["target_commitish"],
        "draft": identity["draft"],
        "prerelease": False,
        "assets": assets,
    }


def build_publisher_provenance(
    repository: str,
    workflow_event: str,
    workflow_run_id: int,
    run_attempt: int,
    execution_head_sha: str,
    source_commit: str,
    source_selection: Any,
    release_identity: Any,
    candidate_stage: str,
) -> dict[str, Any]:
    """Bind one successful Container release attempt to exact GitHub assets."""

    if not isinstance(repository, str) or REPOSITORY_RE.fullmatch(repository) is None:
        _fail("publisher repository has an invalid canonical name")
    if workflow_event not in PUBLISHER_EVENTS:
        _fail("publisher workflow event is not allowed")
    for value, label in (
        (workflow_run_id, "workflow run id"),
        (run_attempt, "run attempt"),
    ):
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            _fail(f"publisher {label} must be a positive integer")
    if (
        COMMIT_RE.fullmatch(execution_head_sha) is None
        or COMMIT_RE.fullmatch(source_commit) is None
    ):
        _fail("publisher execution head and source commits must be lowercase 40-character commits")
    selection = validate_source_selection(
        source_selection, repository, workflow_event, source_commit
    )
    release = validate_release_identity(release_identity, source_commit, candidate_stage)
    return {
        "schema_version": 1,
        "repository": repository,
        "workflow_path": PUBLISHER_WORKFLOW_PATH,
        "workflow_event": workflow_event,
        "workflow_run_id": workflow_run_id,
        "run_attempt": run_attempt,
        "execution_head_branch": "main",
        "execution_head_sha": execution_head_sha,
        "source_commit": source_commit,
        "candidate_stage": candidate_stage,
        "source_selection": selection,
        "release": release,
    }


def validate_source_selection(
    value: Any,
    repository: str,
    workflow_event: str,
    source_commit: str,
) -> dict[str, Any]:
    selection = _object(value, "publisher source selection")
    if set(selection) != SOURCE_SELECTION_KEYS:
        _fail("publisher source selection must have the exact closed shape")
    if selection.get("kind") != workflow_event:
        _fail("publisher source selection kind does not match the workflow event")
    if selection.get("resolution") != SOURCE_SELECTION_RESOLUTION.get(workflow_event):
        _fail("publisher source selection has the wrong resolution rule")
    requested_ref = selection.get("requested_ref")
    if workflow_event == "workflow_run":
        if requested_ref is not None:
            _fail("workflow_run source selection cannot carry a dispatch ref")
    elif (
        not isinstance(requested_ref, str)
        or not requested_ref
        or len(requested_ref) > 256
        or requested_ref != requested_ref.strip()
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in requested_ref)
    ):
        _fail("workflow_dispatch source selection has an invalid requested ref")
    for field in ("qualification_run_id", "qualification_run_attempt"):
        number = selection.get(field)
        if isinstance(number, bool) or not isinstance(number, int) or number <= 0:
            _fail(f"publisher source selection has an invalid {field}")
    if (
        selection.get("qualification_workflow_path") != ".github/workflows/quality.yml"
        or selection.get("qualification_event") != "push"
        or selection.get("qualification_conclusion") != "success"
        or selection.get("qualification_head_branch") != "main"
        or selection.get("qualification_head_sha") != source_commit
        or selection.get("qualification_head_repository") != repository
    ):
        _fail("publisher source selection does not prove the released source commit")
    return {key: selection[key] for key in sorted(SOURCE_SELECTION_KEYS)}


def validate_publisher_provenance(
    value: Any,
    repository: str,
    workflow_event: str,
    workflow_run_id: int,
    run_attempt: int,
    execution_head_sha: str,
    source_commit: str,
    source_selection: Any,
    release_identity: Any,
    candidate_stage: str,
) -> dict[str, Any]:
    provenance = _object(value, "publisher provenance")
    if set(provenance) != PUBLISHER_PROVENANCE_KEYS:
        _fail("publisher provenance must have the exact closed shape")
    expected = build_publisher_provenance(
        repository,
        workflow_event,
        workflow_run_id,
        run_attempt,
        execution_head_sha,
        source_commit,
        source_selection,
        release_identity,
        candidate_stage,
    )
    if provenance != expected:
        _fail("publisher provenance does not match the successful release attempt")
    return provenance


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _load_contract(path: Path) -> dict[str, Any]:
    _require_regular(path, "release-transition contract")
    try:
        return validate_release_transition_contract(
            read_strict_json(path, "release-transition contract"),
            "release-transition contract",
        )
    except DocsSyncError as exc:
        raise PromotionError(str(exc)) from exc


def _load_schema(path: Path, label: str) -> dict[str, Any]:
    _require_regular(path, label)
    value = read_strict_json(path, label)
    return _object(value, label)


def _validate_manifest_for_stage(
    manifest: dict[str, Any],
    contract: dict[str, Any],
    generation: str,
) -> None:
    if manifest.get("channel") != "main" or manifest.get("source_commit") != generation:
        _fail("release manifest does not bind the main-channel candidate generation")
    stage = contract["stage"]
    protocol = contract["manifest_protocol"]
    schema_version = manifest.get("schema_version")
    images = _object(manifest.get("images"), f"{stage} manifest images")
    if any(
        not isinstance(reference, str) or IMAGE_RE.fullmatch(reference) is None
        for reference in images.values()
    ):
        _fail(f"{stage} manifest contains a non-immutable image reference")
    if stage == "bridge":
        if schema_version != protocol["bridge_schema_version"]:
            _fail("bridge must use the bridge manifest schema")
        if set(manifest) != BRIDGE_MANIFEST_KEYS:
            _fail("bridge manifest must have the exact ordinary-plus-handoff shape")
        if manifest.get("protocol_version") != 1 or set(images) != MANAGED_IMAGES_V1:
            _fail("bridge manifest must use protocol 1 and the exact eleven-image set")
        descriptor = _object(manifest.get("namespace_handoff"), "bridge namespace_handoff")
        if set(descriptor) != {
            "schema_version",
            "predecessor_generation",
            "bridge_generation",
            "source",
            "target",
        }:
            _fail("bridge namespace_handoff must be a closed descriptor")
        if (
            descriptor.get("schema_version") != 1
            or descriptor.get("predecessor_generation")
            != contract["predecessor_generation"]
            or descriptor.get("bridge_generation") != generation
        ):
            _fail("bridge namespace_handoff generation binding is invalid")
        source = _object(descriptor.get("source"), "bridge namespace_handoff source")
        target = _object(descriptor.get("target"), "bridge namespace_handoff target")
        for name, binding, profile, version in (
            (
                "source",
                source,
                contract["source_profile_id"],
                contract["predecessor_generation"],
            ),
            ("target", target, contract["target_profile_id"], generation),
        ):
            if set(binding) != {"profile_id", "manager", "compose"}:
                _fail(f"bridge {name} binding must be a closed object")
            if binding.get("profile_id") != profile:
                _fail(f"bridge {name} profile does not match the transition contract")
            manager = _object(binding.get("manager"), f"bridge {name} manager")
            compose = _object(binding.get("compose"), f"bridge {name} compose")
            if set(manager) != {"version", "artifacts"} or manager.get("version") != version:
                _fail(f"bridge {name} manager identity is invalid")
            artifacts = _object(manager.get("artifacts"), f"bridge {name} manager artifacts")
            if set(artifacts) != {"amd64", "arm64"}:
                _fail(f"bridge {name} manager artifacts must contain exactly amd64 and arm64")
            for arch, artifact_value in artifacts.items():
                artifact = _object(artifact_value, f"bridge {name} manager {arch}")
                if (
                    set(artifact) != {"url", "sha256"}
                    or not isinstance(artifact.get("url"), str)
                    or not artifact["url"].startswith("https://")
                    or not isinstance(artifact.get("sha256"), str)
                    or SHA256_RE.fullmatch(artifact["sha256"]) is None
                ):
                    _fail(f"bridge {name} manager {arch} artifact is invalid")
            if (
                set(compose) != {"url", "sha256"}
                or not isinstance(compose.get("url"), str)
                or not compose["url"].startswith("https://")
                or not isinstance(compose.get("sha256"), str)
                or SHA256_RE.fullmatch(compose["sha256"]) is None
            ):
                _fail(f"bridge {name} compose artifact is invalid")
        if target["manager"] != manifest.get("manager"):
            _fail("bridge target manager must exactly match the top-level manager")
        if target["compose"] != manifest.get("compose"):
            _fail("bridge target compose must exactly match the top-level compose")
    elif stage in {"cleanup", "target_baseline"}:
        if schema_version != protocol["cleanup_schema_version"]:
            _fail(f"{stage} must use the target-only manifest schema-v2 barrier")
        if "namespace_handoff" in manifest:
            _fail(f"{stage} manifest must not retain the one-time namespace_handoff descriptor")
        if set(manifest) != ORDINARY_MANIFEST_KEYS:
            _fail(f"{stage} manifest must have the exact target-only shape")
        if manifest.get("protocol_version") != 2 or set(images) != MANAGED_IMAGES_V2:
            _fail(f"{stage} manifest must use protocol 2 and the exact ten-image set")
    else:  # contract validation already protects this
        _fail(f"unsupported transition stage: {stage!r}")


def _promotion_core(
    contract_path: Path,
    manifest_path: Path,
    challenge_schema_path: Path,
    receipt_schema_path: Path,
    generation: str,
    predecessor_generation: str | None = None,
) -> dict[str, Any]:
    if COMMIT_RE.fullmatch(generation) is None:
        _fail("generation must be a lowercase 40-character commit")
    contract = _load_contract(contract_path)
    _require_regular(manifest_path, "release manifest")
    manifest = _object(read_strict_json(manifest_path, "release manifest"), "release manifest")
    challenge_schema = _load_schema(challenge_schema_path, "release-transition challenge schema")
    receipt_schema = _load_schema(receipt_schema_path, "release-transition receipt schema")
    # Schema structure is validated by docs_sync; loading it here makes the
    # asset bind the exact schema bytes used by the verifier.
    if challenge_schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
        _fail("challenge schema is not draft 2020-12")
    if receipt_schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
        _fail("receipt schema is not draft 2020-12")
    _validate_manifest_for_stage(manifest, contract, generation)
    stage = contract["stage"]
    if predecessor_generation is not None:
        if stage != "target_baseline":
            _fail("only target_baseline may bind its public predecessor at publication")
        if (
            COMMIT_RE.fullmatch(predecessor_generation) is None
            or predecessor_generation == generation
        ):
            _fail("target_baseline publication predecessor is invalid")
    else:
        predecessor_generation = contract["predecessor_generation"]
    receipt_policy = contract["deployment_receipt"]
    required_receipt: str | None
    if stage == "bridge":
        required_receipt = receipt_policy["source_owner_receipt_type"]
    elif stage == "cleanup":
        required_receipt = receipt_policy["target_commit_receipt_type"]
    else:
        # Once cleanup establishes the target-only baseline, ordinary target
        # generations continue without one-time deployment attestation.
        required_receipt = None
    return {
        "schema_version": 1,
        "transition_id": contract["transition_id"],
        "stage": stage,
        "generation": generation,
        "predecessor_generation": predecessor_generation,
        "source_profile_id": contract["source_profile_id"],
        "target_profile_id": contract["target_profile_id"],
        "manifest_schema_version": manifest["schema_version"],
        "manifest_sha256": _sha256(manifest_path),
        "contract_sha256": _sha256(contract_path),
        "challenge_schema_sha256": _sha256(challenge_schema_path),
        "receipt_schema_sha256": _sha256(receipt_schema_path),
        "required_receipt_type": required_receipt,
    }


def build_promotion(
    contract_path: Path,
    manifest_path: Path,
    challenge_schema_path: Path,
    receipt_schema_path: Path,
    generation: str,
    assets_root: Path,
    predecessor_generation: str | None = None,
) -> dict[str, Any]:
    result = _promotion_core(
        contract_path,
        manifest_path,
        challenge_schema_path,
        receipt_schema_path,
        generation,
        predecessor_generation,
    )
    stage = result["stage"]
    result["sealed_assets"] = _sealed_assets(assets_root, stage)
    _validate_sealed_assets(
        result["sealed_assets"], result["manifest_sha256"], stage
    )
    return result


def validate_promotion(
    promotion_path: Path,
    contract_path: Path,
    manifest_path: Path,
    challenge_schema_path: Path,
    receipt_schema_path: Path,
    generation: str,
    assets_root: Path | None = None,
) -> dict[str, Any]:
    _require_regular(promotion_path, "promotion record")
    promotion = _object(
        read_strict_json(promotion_path, "promotion record"), "promotion record"
    )
    if set(promotion) != PROMOTION_KEYS:
        _fail("promotion record must have the exact closed shape")
    stage = promotion.get("stage")
    if not isinstance(stage, str):
        _fail("promotion record has no valid stage")
    sealed_assets = _validate_sealed_assets(
        promotion.get("sealed_assets"), promotion.get("manifest_sha256"), stage
    )
    expected = _promotion_core(
        contract_path,
        manifest_path,
        challenge_schema_path,
        receipt_schema_path,
        generation,
        promotion.get("predecessor_generation")
        if stage == "target_baseline"
        else None,
    )
    expected["sealed_assets"] = (
        _sealed_assets(assets_root, stage) if assets_root is not None else sealed_assets
    )
    _validate_sealed_assets(
        expected["sealed_assets"], expected["manifest_sha256"], stage
    )
    if promotion != expected:
        _fail("promotion record does not match its immutable contract and release assets")
    return promotion


def _load_metadata(path: Path, generation: str) -> dict[str, Any]:
    metadata = _object(read_strict_json(path, "release metadata"), "release metadata")
    if set(metadata) != {"tag_name", "draft", "target_commitish"}:
        _fail("release metadata must contain exactly tag_name, draft, and target_commitish")
    if (
        metadata["tag_name"] != f"container-{generation}"
        or metadata["target_commitish"] != generation
        or not isinstance(metadata["draft"], bool)
    ):
        _fail("release metadata does not match candidate generation")
    return metadata


def ensure_publication_slot(
    current_generation: str,
    candidate_generation: str,
    candidate_stage: str,
    candidates_root: Path,
) -> None:
    """Reject a second sealed same-stage draft for one direct predecessor.

    The caller materializes only draft releases whose promotion asset already
    exists (promotion.json is the seal uploaded last).  Container publishers
    invoke this beneath the repository-wide publish concurrency group.
    """

    for label, generation in (
        ("current", current_generation),
        ("candidate", candidate_generation),
    ):
        if COMMIT_RE.fullmatch(generation) is None:
            _fail(f"{label} generation must be a lowercase 40-character commit")
    if candidate_stage not in {"bridge", "cleanup", "target_baseline"}:
        _fail("publication slot candidate stage is invalid")
    if not candidates_root.is_dir() or candidates_root.is_symlink():
        _fail("target publication slot root must be a non-symlink directory")
    blockers: list[str] = []
    for root in sorted(candidates_root.iterdir()):
        if not root.is_dir() or COMMIT_RE.fullmatch(root.name) is None:
            _fail("target publication slot contains an unknown entry")
        metadata = _load_metadata(root / "metadata.json", root.name)
        if metadata["draft"] is not True:
            _fail("target publication slot input must contain only drafts")
        record = _object(
            read_strict_json(root / "promotion.json", "target draft promotion"),
            "target draft promotion",
        )
        record_stage = record.get("stage")
        if record_stage not in {"bridge", "cleanup", "target_baseline"}:
            _fail("sealed draft promotion stage is invalid")
        if record_stage != candidate_stage:
            continue
        if record.get("generation") != root.name:
            _fail("target draft promotion generation does not match its directory")
        predecessor = record.get("predecessor_generation")
        if not isinstance(predecessor, str) or COMMIT_RE.fullmatch(predecessor) is None:
            _fail("target draft promotion predecessor is invalid")
        if predecessor == current_generation and root.name != candidate_generation:
            blockers.append(root.name)
    if blockers:
        _fail(
            "target publication slot is occupied by sealed direct successor "
            + ",".join(blockers)
        )


def _validate_historical_source_owner_current(
    root: Path, generation: str
) -> dict[str, Any]:
    """Verify the sealed predecessor without reviving its retired parser."""

    promotion_path = root / "promotion.json"
    _require_regular(promotion_path, "historical promotion record")
    record = _object(
        read_strict_json(promotion_path, "historical promotion record"),
        "historical promotion record",
    )
    if set(record) != PROMOTION_KEYS:
        _fail("historical promotion record must have the exact closed shape")
    if (
        record.get("schema_version") != 1
        or record.get("stage") != "source_owner"
        or record.get("generation") != generation
        or record.get("manifest_schema_version") != 1
        or record.get("required_receipt_type") is not None
        or not isinstance(record.get("transition_id"), str)
        or not record["transition_id"]
        or not isinstance(record.get("source_profile_id"), str)
        or not record["source_profile_id"]
        or not isinstance(record.get("target_profile_id"), str)
        or not record["target_profile_id"]
        or not isinstance(record.get("predecessor_generation"), str)
        or COMMIT_RE.fullmatch(record["predecessor_generation"]) is None
    ):
        _fail("historical source-owner promotion identity is invalid")
    bound_files = {
        "manifest_sha256": root / "release.json",
        "contract_sha256": root / "release-transition.json",
        "challenge_schema_sha256": root
        / "release-transition-challenge.schema.json",
        "receipt_schema_sha256": root / "release-transition-receipt.schema.json",
    }
    for field, path in bound_files.items():
        _require_regular(path, f"historical {field} file")
        digest = record.get(field)
        if (
            not isinstance(digest, str)
            or SHA256_RE.fullmatch(digest) is None
            or digest != _sha256(path)
        ):
            _fail(f"historical source-owner {field} does not match sealed bytes")
    sealed = _validate_sealed_assets(
        record.get("sealed_assets"), record["manifest_sha256"], "source_owner"
    )
    if sealed != _sealed_assets(root, "source_owner"):
        _fail("historical source-owner sealed asset directory has drifted")
    manifest = _object(
        read_strict_json(root / "release.json", "historical release manifest"),
        "historical release manifest",
    )
    if (
        set(manifest) != ORDINARY_MANIFEST_KEYS
        or manifest.get("schema_version") != 1
        or manifest.get("protocol_version") != 1
        or manifest.get("channel") != "main"
        or manifest.get("source_commit") != generation
    ):
        _fail("historical source-owner manifest identity is invalid")
    if _load_metadata(root / "metadata.json", generation)["draft"] is not False:
        _fail("historical source-owner current release must already be public")
    return record


def _validate_predecessor_artifact_binding(
    candidate_manifest: dict[str, Any],
    predecessor_manifest: dict[str, Any],
    stage: str,
) -> None:
    """Bind bridge rollback inputs to the exact current release artifacts.

    A deployment receipt proves one running predecessor architecture.  It does
    not, by itself, prove that the bridge descriptor retained the predecessor's
    Compose artifact or the Manager artifact for the other architecture.  The
    serialized evaluator has both immutable manifests available, so reject a
    bridge whose declared source side is not byte-for-byte the current release
    directory before issuing or accepting any deployment challenge.
    """

    if stage != "bridge":
        return
    descriptor = _object(
        candidate_manifest.get("namespace_handoff"),
        "bridge namespace_handoff",
    )
    source = _object(descriptor.get("source"), "bridge namespace_handoff source")
    if source.get("manager") != predecessor_manifest.get("manager"):
        _fail("bridge source manager must exactly match the predecessor manifest")
    if source.get("compose") != predecessor_manifest.get("compose"):
        _fail("bridge source compose must exactly match the predecessor manifest")


def _prebuilt_cleanup_for_bridge(
    candidates_root: Path, bridge: dict[str, Any]
) -> str | None:
    """Require the sealed target-only escape hatch before Bridge visibility.

    Cleanup is intentionally assembled while Bridge is still draft.  Merely
    documenting that ordering is not enough: the serialized evaluator must
    refuse to issue a Bridge challenge until one immutable Cleanup draft is
    already present and directly bound to that Bridge generation.
    """

    matches: list[str] = []
    bridge_generation = bridge["generation"]
    for root in sorted(candidates_root.iterdir()):
        if (
            not root.is_dir()
            or root.name == bridge_generation
            or COMMIT_RE.fullmatch(root.name) is None
            or not (root / "promotion.json").is_file()
        ):
            continue
        header = _object(
            read_strict_json(root / "promotion.json", "prebuilt Cleanup promotion"),
            "prebuilt Cleanup promotion",
        )
        if (
            header.get("stage") != "cleanup"
            or header.get("predecessor_generation") != bridge_generation
        ):
            continue
        cleanup = validate_promotion(
            root / "promotion.json",
            root / "release-transition.json",
            root / "release.json",
            root / "release-transition-challenge.schema.json",
            root / "release-transition-receipt.schema.json",
            root.name,
        )
        if _load_metadata(root / "metadata.json", root.name)["draft"] is not True:
            _fail("prebuilt Cleanup must remain draft before Bridge publication")
        for field in ("transition_id", "source_profile_id", "target_profile_id"):
            if cleanup[field] != bridge[field]:
                _fail(f"prebuilt Cleanup changes Bridge transition binding {field}")
        matches.append(root.name)
    if not matches:
        return None
    if len(matches) != 1:
        _fail("Bridge has multiple sealed direct Cleanup drafts")
    return matches[0]


def select_candidate(
    current_generation: str,
    candidates_root: Path,
    current_root: Path | None,
) -> dict[str, Any]:
    if COMMIT_RE.fullmatch(current_generation) is None:
        _fail("current generation must be a lowercase 40-character commit")
    if current_root is None:
        _fail("current release must have a complete sealed promotion directory")
    current_header = _object(
        read_strict_json(current_root / "promotion.json", "current promotion record"),
        "current promotion record",
    )
    if current_header.get("stage") == "source_owner":
        current_promotion = _validate_historical_source_owner_current(
            current_root, current_generation
        )
    else:
        current_promotion = validate_promotion(
            current_root / "promotion.json",
            current_root / "release-transition.json",
            current_root / "release.json",
            current_root / "release-transition-challenge.schema.json",
            current_root / "release-transition-receipt.schema.json",
            current_generation,
            current_root,
        )
    eligible: list[dict[str, Any]] = []
    if not candidates_root.is_dir():
        _fail("candidate root is missing")
    for candidate_root in sorted(candidates_root.iterdir()):
        if not candidate_root.is_dir() or COMMIT_RE.fullmatch(candidate_root.name) is None:
            continue
        generation = candidate_root.name
        if generation == current_generation:
            continue
        candidate_header = _object(
            read_strict_json(
                candidate_root / "promotion.json", "candidate promotion record"
            ),
            "candidate promotion record",
        )
        if candidate_header.get("predecessor_generation") != current_generation:
            continue
        if candidate_header.get("stage") == "source_owner":
            _fail("new source_owner releases are closed after the sealed predecessor")
        promotion = validate_promotion(
            candidate_root / "promotion.json",
            candidate_root / "release-transition.json",
            candidate_root / "release.json",
            candidate_root / "release-transition-challenge.schema.json",
            candidate_root / "release-transition-receipt.schema.json",
            generation,
        )
        metadata = _load_metadata(candidate_root / "metadata.json", generation)
        stage = promotion["stage"]
        if metadata["draft"] is not True:
            _fail(f"unpromoted {stage} release is not draft")
        if stage == "target_baseline":
            if current_promotion["stage"] not in TARGET_BASELINE_PREDECESSORS:
                _fail("target_baseline must directly follow cleanup or target_baseline")
            for field in ("transition_id", "target_profile_id"):
                if promotion[field] != current_promotion[field]:
                    _fail(f"target_baseline changes target transition binding {field}")
        else:
            expected_stage = STAGE_PREDECESSOR[stage]
            if current_promotion["stage"] != expected_stage:
                _fail(f"{stage} does not directly follow {expected_stage}")
            for field in ("transition_id", "source_profile_id", "target_profile_id"):
                if promotion[field] != current_promotion[field]:
                    _fail(f"{stage} changes transition binding {field}")
            if stage == "bridge":
                _validate_predecessor_artifact_binding(
                    _object(
                        read_strict_json(candidate_root / "release.json", "bridge manifest"),
                        "bridge manifest",
                    ),
                    _object(
                        read_strict_json(current_root / "release.json", "predecessor manifest"),
                        "predecessor manifest",
                    ),
                    stage,
                )
        eligible.append({**promotion, "draft": metadata["draft"]})
    if not eligible:
        return {"action": "none"}
    if len(eligible) != 1:
        _fail("multiple releases claim the same direct predecessor")
    candidate = eligible[0]
    result: dict[str, Any] = {"action": "promote", "candidate": candidate}
    if candidate["stage"] == "bridge":
        cleanup = _prebuilt_cleanup_for_bridge(
            candidates_root, candidate
        )
        if cleanup is None:
            return {"action": "prepare_cleanup", "candidate": candidate}
        result["prebuilt_cleanup_generation"] = cleanup
    return result


def _utc_now(value: str | None) -> dt.datetime:
    if value is None:
        return dt.datetime.now(tz=dt.timezone.utc).replace(microsecond=0)
    parsed = _timestamp(value, "current time")
    return parsed


def _timestamp(value: Any, label: str) -> dt.datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        _fail(f"{label} must be an RFC3339 UTC timestamp")
    try:
        parsed = dt.datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as exc:
        raise PromotionError(f"{label} must be an RFC3339 UTC timestamp") from exc
    if parsed.tzinfo != dt.timezone.utc:
        _fail(f"{label} must use UTC")
    return parsed


def _format_time(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _expected_gate(promotion: dict[str, Any], contract: dict[str, Any]) -> tuple[str, str, str, str]:
    if promotion["stage"] == "bridge":
        return (
            contract["deployment_receipt"]["source_owner_receipt_type"],
            contract["source_profile_id"],
            "source_owner",
            "idle",
        )
    if promotion["stage"] == "cleanup":
        return (
            contract["deployment_receipt"]["target_commit_receipt_type"],
            contract["target_profile_id"],
            "target_owner",
            "committed",
        )
    _fail("ordinary source_owner and target_baseline promotion do not use a deployment receipt")


def issue_challenge(
    promotion: dict[str, Any],
    contract: dict[str, Any],
    schema: dict[str, Any],
    deployment_id: str,
    key_id: str,
    current_generation: str,
    now: dt.datetime,
) -> dict[str, Any]:
    if promotion["predecessor_generation"] != current_generation:
        _fail("candidate is no longer the direct successor of current latest")
    receipt_type, profile, capability, status = _expected_gate(promotion, contract)
    ttl = contract["deployment_receipt"]["challenge_ttl_seconds"]
    challenge = {
        "schema_version": 1,
        "transition_id": promotion["transition_id"],
        "challenge_id": "challenge_" + secrets.token_hex(16),
        "nonce": base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("="),
        "receipt_type": receipt_type,
        "deployment_id": deployment_id,
        "key_id": key_id,
        "predecessor_generation": current_generation,
        "candidate_generation": promotion["generation"],
        "expected_observed_generation": current_generation,
        "expected_profile_id": profile,
        "expected_capability": capability,
        "expected_status": status,
        "issued_at": _format_time(now),
        "expires_at": _format_time(now + dt.timedelta(seconds=ttl)),
    }
    try:
        return validate_closed_json_schema_instance(challenge, schema, "challenge")
    except DocsSyncError as exc:
        raise PromotionError(str(exc)) from exc


def canonical_json(value: Any) -> bytes:
    """Return RFC8785 bytes for the deliberately ASCII, integer-only schema."""

    def inspect(item: Any) -> None:
        if isinstance(item, dict):
            for key, child in item.items():
                if not isinstance(key, str) or not key.isascii():
                    _fail("canonical receipt object keys must be ASCII strings")
                inspect(child)
        elif isinstance(item, list):
            for child in item:
                inspect(child)
        elif isinstance(item, str):
            if not item.isascii():
                _fail("canonical receipt values must be ASCII")
        elif isinstance(item, bool) or item is None or isinstance(item, int):
            return
        else:
            _fail("canonical receipt contains an unsupported JSON value")

    inspect(value)
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _verify_ed25519(public_key: Path, canonical: bytes, signature_text: str) -> None:
    _require_regular(public_key, "Ed25519 public key")
    public_der = subprocess.run(
        [
            "openssl",
            "pkey",
            "-pubin",
            "-in",
            str(public_key),
            "-outform",
            "DER",
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    # SubjectPublicKeyInfo for Ed25519 is the fixed algorithm identifier
    # 1.3.101.112 followed by a 32-byte public key.
    ed25519_spki_prefix = bytes.fromhex("302a300506032b6570032100")
    if public_der.returncode != 0 or len(public_der.stdout) != 44 or not public_der.stdout.startswith(ed25519_spki_prefix):
        _fail("pinned receipt key is not an Ed25519 public key")
    try:
        signature = base64.b64decode(signature_text.strip(), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise PromotionError("receipt signature must be strict standard base64") from exc
    if len(signature) != 64:
        _fail("Ed25519 receipt signature must be 64 bytes")
    with tempfile.TemporaryDirectory(prefix="release-receipt-") as directory:
        root = Path(directory)
        message_path = root / "receipt.jcs"
        signature_path = root / "receipt.sig"
        message_path.write_bytes(canonical)
        signature_path.write_bytes(signature)
        result = subprocess.run(
            [
                "openssl",
                "pkeyutl",
                "-verify",
                "-pubin",
                "-inkey",
                str(public_key),
                "-rawin",
                "-in",
                str(message_path),
                "-sigfile",
                str(signature_path),
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    if result.returncode != 0:
        _fail("Ed25519 receipt signature is invalid")


def verify_receipt(
    promotion: dict[str, Any],
    contract: dict[str, Any],
    challenge_schema: dict[str, Any],
    receipt_schema: dict[str, Any],
    challenge_value: Any,
    receipt_value: Any,
    signature_text: str,
    public_key: Path,
    deployment_id: str,
    key_id: str,
    current_generation: str,
    predecessor_manifest: dict[str, Any],
    consumed_challenges: set[str],
    now: dt.datetime,
) -> dict[str, Any]:
    try:
        challenge = validate_closed_json_schema_instance(
            challenge_value, challenge_schema, "challenge"
        )
        receipt = validate_closed_json_schema_instance(
            receipt_value, receipt_schema, "receipt"
        )
    except DocsSyncError as exc:
        raise PromotionError(str(exc)) from exc
    if challenge["challenge_id"] in consumed_challenges:
        _fail("challenge was already consumed")
    if current_generation != promotion["predecessor_generation"]:
        _fail("latest changed after the challenge was issued")
    expected_type, expected_profile, expected_capability, expected_status = _expected_gate(
        promotion, contract
    )
    expected_challenge = {
        "transition_id": promotion["transition_id"],
        "receipt_type": expected_type,
        "deployment_id": deployment_id,
        "key_id": key_id,
        "predecessor_generation": current_generation,
        "candidate_generation": promotion["generation"],
        "expected_observed_generation": current_generation,
        "expected_profile_id": expected_profile,
        "expected_capability": expected_capability,
        "expected_status": expected_status,
    }
    for field, expected in expected_challenge.items():
        if challenge[field] != expected:
            _fail(f"challenge has wrong {field}")
    challenge_issued = _timestamp(challenge["issued_at"], "challenge.issued_at")
    challenge_expires = _timestamp(challenge["expires_at"], "challenge.expires_at")
    challenge_ttl = contract["deployment_receipt"]["challenge_ttl_seconds"]
    if not challenge_issued <= now < challenge_expires:
        _fail("challenge is not currently valid")
    if challenge_expires <= challenge_issued or challenge_expires - challenge_issued > dt.timedelta(seconds=challenge_ttl):
        _fail("challenge exceeds its canonical TTL")
    copied = {
        "transition_id": "transition_id",
        "challenge_id": "challenge_id",
        "nonce": "nonce",
        "receipt_type": "receipt_type",
        "deployment_id": "deployment_id",
        "key_id": "key_id",
        "predecessor_generation": "predecessor_generation",
        "candidate_generation": "candidate_generation",
        "observed_generation": "expected_observed_generation",
        "profile_id": "expected_profile_id",
        "capability": "expected_capability",
        "status": "expected_status",
    }
    for receipt_field, challenge_field in copied.items():
        if receipt[receipt_field] != challenge[challenge_field]:
            _fail(f"receipt has wrong {receipt_field}")
    receipt_issued = _timestamp(receipt["issued_at"], "receipt.issued_at")
    receipt_expires = _timestamp(receipt["expires_at"], "receipt.expires_at")
    receipt_ttl = contract["deployment_receipt"]["receipt_ttl_seconds"]
    if receipt_issued < challenge_issued or not receipt_issued <= now < receipt_expires:
        _fail("receipt is not currently valid")
    if receipt_expires <= receipt_issued or receipt_expires > challenge_expires or receipt_expires - receipt_issued > dt.timedelta(seconds=receipt_ttl):
        _fail("receipt exceeds the challenge or canonical receipt TTL")
    if predecessor_manifest.get("source_commit") != current_generation:
        _fail("predecessor manifest does not match current latest")
    architecture = receipt["architecture"]
    try:
        expected_manager_sha = predecessor_manifest["manager"]["artifacts"][architecture]["sha256"]
    except (KeyError, TypeError) as exc:
        raise PromotionError("predecessor manifest has no Manager artifact for receipt architecture") from exc
    if not isinstance(expected_manager_sha, str) or SHA256_RE.fullmatch(expected_manager_sha) is None:
        _fail("predecessor manifest Manager digest is invalid")
    if receipt["manager_sha256"] != expected_manager_sha:
        _fail("receipt was not signed by the expected running Manager generation")
    _verify_ed25519(public_key, canonical_json(receipt), signature_text)
    return receipt


def _read_signature(path: Path) -> str:
    _require_regular(path, "receipt signature")
    return path.read_text(encoding="ascii")


def _load_consumed(path: Path | None) -> set[str]:
    if path is None or not path.exists():
        return set()
    value = _object(read_strict_json(path, "consumed challenge ledger"), "consumed challenge ledger")
    if set(value) != {"schema_version", "challenge_ids"} or value["schema_version"] != 1:
        _fail("consumed challenge ledger has an invalid shape")
    ids = value["challenge_ids"]
    if not isinstance(ids, list) or any(not isinstance(item, str) for item in ids) or len(set(ids)) != len(ids):
        _fail("consumed challenge ledger challenge_ids is invalid")
    return set(ids)


def _promotion_inputs(arguments: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    promotion = validate_promotion(
        arguments.promotion,
        arguments.contract,
        arguments.manifest,
        arguments.challenge_schema,
        arguments.receipt_schema,
        arguments.generation,
    )
    return (
        promotion,
        _load_contract(arguments.contract),
        _load_schema(arguments.challenge_schema, "release-transition challenge schema"),
        _load_schema(arguments.receipt_schema, "release-transition receipt schema"),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    validate_contract = commands.add_parser("validate-contract")
    validate_contract.add_argument("--contract", type=Path, required=True)

    for name in ("create-promotion", "validate-promotion"):
        command = commands.add_parser(name)
        command.add_argument("--contract", type=Path, required=True)
        command.add_argument("--manifest", type=Path, required=True)
        command.add_argument("--challenge-schema", type=Path, required=True)
        command.add_argument("--receipt-schema", type=Path, required=True)
        command.add_argument("--generation", required=True)
        if name == "create-promotion":
            command.add_argument("--assets-root", type=Path, required=True)
            command.add_argument("--predecessor-generation")
            command.add_argument("--output", type=Path, required=True)
        else:
            command.add_argument("--assets-root", type=Path)
            command.add_argument("--promotion", type=Path, required=True)

    select = commands.add_parser("select-candidate")
    select.add_argument("--current-generation", required=True)
    select.add_argument("--candidates-root", type=Path, required=True)
    select.add_argument("--current-root", type=Path, required=True)
    select.add_argument("--output", type=Path, required=True)

    publication_slot = commands.add_parser("ensure-publication-slot")
    publication_slot.add_argument("--current-generation", required=True)
    publication_slot.add_argument("--candidate-generation", required=True)
    publication_slot.add_argument(
        "--candidate-stage", choices=("bridge", "cleanup", "target_baseline"), required=True
    )
    publication_slot.add_argument("--candidates-root", type=Path, required=True)

    for name in ("create-publisher-provenance", "validate-publisher-provenance"):
        command = commands.add_parser(name)
        command.add_argument("--repository", required=True)
        command.add_argument("--workflow-event", required=True)
        command.add_argument("--workflow-run-id", type=int, required=True)
        command.add_argument("--run-attempt", type=int, required=True)
        command.add_argument("--execution-head-sha", required=True)
        command.add_argument("--source-commit", required=True)
        command.add_argument("--source-selection", type=Path, required=True)
        command.add_argument("--release-identity", type=Path, required=True)
        command.add_argument(
            "--candidate-stage", choices=tuple(sorted(PUBLISHER_STAGES)), required=True
        )
        if name == "create-publisher-provenance":
            command.add_argument("--output", type=Path, required=True)
        else:
            command.add_argument("--provenance", type=Path, required=True)

    for name in ("issue-challenge", "verify-receipt"):
        command = commands.add_parser(name)
        command.add_argument("--contract", type=Path, required=True)
        command.add_argument("--manifest", type=Path, required=True)
        command.add_argument("--challenge-schema", type=Path, required=True)
        command.add_argument("--receipt-schema", type=Path, required=True)
        command.add_argument("--promotion", type=Path, required=True)
        command.add_argument("--generation", required=True)
        command.add_argument("--current-generation", required=True)
        command.add_argument("--deployment-id", required=True)
        command.add_argument("--key-id", required=True)
        command.add_argument("--now")
        if name == "issue-challenge":
            command.add_argument("--output", type=Path, required=True)
        else:
            command.add_argument("--challenge", type=Path, required=True)
            command.add_argument("--receipt", type=Path, required=True)
            command.add_argument("--signature", type=Path, required=True)
            command.add_argument("--public-key", type=Path, required=True)
            command.add_argument("--predecessor-manifest", type=Path, required=True)
            command.add_argument("--consumed-challenges", type=Path)

    canonicalize = commands.add_parser("canonicalize")
    canonicalize.add_argument("--schema", type=Path, required=True)
    canonicalize.add_argument("--input", type=Path, required=True)
    canonicalize.add_argument("--output", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    try:
        if arguments.command == "validate-contract":
            _load_contract(arguments.contract)
        elif arguments.command == "create-promotion":
            promotion = build_promotion(
                arguments.contract,
                arguments.manifest,
                arguments.challenge_schema,
                arguments.receipt_schema,
                arguments.generation,
                arguments.assets_root,
                arguments.predecessor_generation,
            )
            _write_json(arguments.output, promotion)
        elif arguments.command == "validate-promotion":
            validate_promotion(
                arguments.promotion,
                arguments.contract,
                arguments.manifest,
                arguments.challenge_schema,
                arguments.receipt_schema,
                arguments.generation,
                arguments.assets_root,
            )
        elif arguments.command == "select-candidate":
            result = select_candidate(
                arguments.current_generation,
                arguments.candidates_root,
                arguments.current_root,
            )
            _write_json(arguments.output, result)
        elif arguments.command == "ensure-publication-slot":
            ensure_publication_slot(
                arguments.current_generation,
                arguments.candidate_generation,
                arguments.candidate_stage,
                arguments.candidates_root,
            )
        elif arguments.command in {
            "create-publisher-provenance",
            "validate-publisher-provenance",
        }:
            release_identity = read_strict_json(
                arguments.release_identity, "release identity"
            )
            source_selection = read_strict_json(
                arguments.source_selection, "publisher source selection"
            )
            if arguments.command == "create-publisher-provenance":
                provenance = build_publisher_provenance(
                    arguments.repository,
                    arguments.workflow_event,
                    arguments.workflow_run_id,
                    arguments.run_attempt,
                    arguments.execution_head_sha,
                    arguments.source_commit,
                    source_selection,
                    release_identity,
                    arguments.candidate_stage,
                )
                _write_json(arguments.output, provenance)
            else:
                validate_publisher_provenance(
                    read_strict_json(arguments.provenance, "publisher provenance"),
                    arguments.repository,
                    arguments.workflow_event,
                    arguments.workflow_run_id,
                    arguments.run_attempt,
                    arguments.execution_head_sha,
                    arguments.source_commit,
                    source_selection,
                    release_identity,
                    arguments.candidate_stage,
                )
        elif arguments.command == "issue-challenge":
            promotion, contract, challenge_schema, _ = _promotion_inputs(arguments)
            if arguments.current_generation != promotion["predecessor_generation"]:
                _fail("candidate is not the direct successor of current latest")
            challenge = issue_challenge(
                promotion,
                contract,
                challenge_schema,
                arguments.deployment_id,
                arguments.key_id,
                arguments.current_generation,
                _utc_now(arguments.now),
            )
            _write_json(arguments.output, challenge)
        elif arguments.command == "verify-receipt":
            promotion, contract, challenge_schema, receipt_schema = _promotion_inputs(arguments)
            receipt = verify_receipt(
                promotion,
                contract,
                challenge_schema,
                receipt_schema,
                read_strict_json(arguments.challenge, "challenge"),
                read_strict_json(arguments.receipt, "receipt"),
                _read_signature(arguments.signature),
                arguments.public_key,
                arguments.deployment_id,
                arguments.key_id,
                arguments.current_generation,
                _object(
                    read_strict_json(arguments.predecessor_manifest, "predecessor manifest"),
                    "predecessor manifest",
                ),
                _load_consumed(arguments.consumed_challenges),
                _utc_now(arguments.now),
            )
            print(receipt["challenge_id"])
        elif arguments.command == "canonicalize":
            schema = _load_schema(arguments.schema, "canonical schema")
            value = read_strict_json(arguments.input, "canonical input")
            try:
                validated = validate_closed_json_schema_instance(value, schema, "canonical input")
            except DocsSyncError as exc:
                raise PromotionError(str(exc)) from exc
            arguments.output.write_bytes(canonical_json(validated))
        else:  # pragma: no cover
            _fail("unknown command")
    except (PromotionError, DocsSyncError, OSError) as exc:
        print(f"release promotion rejected: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
