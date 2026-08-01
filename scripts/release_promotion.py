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
SEALED_RELEASE_ASSETS = tuple(
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
ALL_RELEASE_ASSETS = tuple(sorted((*SEALED_RELEASE_ASSETS, "promotion.json")))
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
    "source_selection",
    "release",
}
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
STAGE_PREDECESSOR = {
    "bridge": "source_owner",
    "cleanup": "bridge",
}
TARGET_BASELINE_PREDECESSORS = {"cleanup", "target_baseline"}


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


def _sealed_assets(root: Path) -> list[dict[str, Any]]:
    try:
        info = root.lstat()
    except FileNotFoundError as exc:
        raise PromotionError(f"sealed asset root is missing: {root}") from exc
    if not stat.S_ISDIR(info.st_mode) or root.is_symlink():
        _fail(f"sealed asset root must be a non-symlink directory: {root}")
    assets: list[dict[str, Any]] = []
    for name in SEALED_RELEASE_ASSETS:
        path = root / name
        _require_regular(path, f"sealed release asset {name}")
        size = path.stat().st_size
        if size <= 0:
            _fail(f"sealed release asset must not be empty: {name}")
        assets.append({"name": name, "sha256": _sha256(path), "size": size})
    return assets


def _validate_sealed_assets(value: Any, manifest_sha256: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or len(value) != len(SEALED_RELEASE_ASSETS):
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
        if not isinstance(name, str) or name not in SEALED_RELEASE_ASSETS:
            _fail("sealed release asset has an unknown name")
        if not isinstance(digest, str) or SHA256_RE.fullmatch(digest) is None:
            _fail(f"sealed release asset has an invalid digest: {name}")
        if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
            _fail(f"sealed release asset has an invalid size: {name}")
        names.append(name)
        assets.append({"name": name, "sha256": digest, "size": size})
    if names != list(SEALED_RELEASE_ASSETS) or len(set(names)) != len(names):
        _fail("sealed release assets must be unique and sorted by exact name")
    release_asset = next(asset for asset in assets if asset["name"] == "release.json")
    if release_asset["sha256"] != manifest_sha256:
        _fail("sealed release.json does not match the bound manifest")
    return assets


def validate_release_identity(value: Any, generation: str) -> dict[str, Any]:
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
    raw_assets = identity.get("assets")
    if not isinstance(raw_assets, list) or len(raw_assets) != len(ALL_RELEASE_ASSETS):
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
        if not isinstance(name, str) or name not in ALL_RELEASE_ASSETS:
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
    if names != list(ALL_RELEASE_ASSETS) or len(set(names)) != len(names):
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
    release = validate_release_identity(release_identity, source_commit)
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
    if stage == "source_owner":
        if schema_version != protocol["ordinary_schema_version"]:
            _fail("source_owner must use the ordinary manifest schema")
        if set(manifest) != ORDINARY_MANIFEST_KEYS:
            _fail("source_owner manifest must preserve the exact ordinary nine-key shape")
    elif stage == "bridge":
        if schema_version != protocol["bridge_schema_version"]:
            _fail("bridge must use the bridge manifest schema")
        if not isinstance(manifest.get("namespace_handoff"), dict):
            _fail("bridge manifest must carry namespace_handoff")
    elif stage in {"cleanup", "target_baseline"}:
        if schema_version != protocol["cleanup_schema_version"]:
            _fail(f"{stage} must use the target-only manifest schema-v2 barrier")
        if "namespace_handoff" in manifest:
            _fail(f"{stage} manifest must not retain the one-time namespace_handoff descriptor")
    else:  # contract validation already protects this
        _fail(f"unsupported transition stage: {stage!r}")


def validate_source_owner_compat(
    root: Path,
    contract: dict[str, Any],
    current_generation: str,
) -> dict[str, Any]:
    """Validate the one canonical pre-promotion P1 release directory.

    P1 predates ``promotion.json`` and publisher provenance.  This is not a
    generic legacy decoder: it is enabled only by the source-owner contract
    and accepts the exact eight-asset release plus the two contract-pinned
    byte digests.
    """

    compat = contract.get("source_owner_compat")
    if contract.get("stage") != "source_owner" or not isinstance(compat, dict):
        _fail("legacy current release is allowed only by source_owner_compat")
    if compat.get("generation") != current_generation:
        _fail("source_owner_compat does not bind the exact current generation")
    try:
        root_info = root.lstat()
    except FileNotFoundError as exc:
        raise PromotionError("canonical source_owner predecessor directory is missing") from exc
    if not stat.S_ISDIR(root_info.st_mode) or root.is_symlink():
        _fail("canonical source_owner predecessor root must be a non-symlink directory")
    actual_names = sorted(path.name for path in root.iterdir())
    if actual_names != list(SEALED_RELEASE_ASSETS):
        _fail("canonical source_owner predecessor must have the exact P1 asset set")
    observed_assets = _sealed_assets(root)
    observed = {asset["name"]: asset for asset in observed_assets}
    if observed["release.json"]["sha256"] != compat.get("manifest_sha256"):
        _fail("canonical source_owner predecessor manifest bytes do not match the contract")
    if observed["ubitech-compose.yaml"]["sha256"] != compat.get("compose_sha256"):
        _fail("canonical source_owner predecessor Compose bytes do not match the contract")
    manifest = _object(
        read_strict_json(root / "release.json", "canonical source_owner predecessor manifest"),
        "canonical source_owner predecessor manifest",
    )
    if (
        set(manifest) != ORDINARY_MANIFEST_KEYS
        or manifest.get("schema_version") != 1
        or manifest.get("channel") != "main"
        or manifest.get("source_commit") != current_generation
        or manifest.get("protocol_version") != 1
    ):
        _fail("canonical source_owner predecessor manifest has the wrong closed identity")
    manager = _object(manifest.get("manager"), "canonical source_owner predecessor manager")
    compose = _object(manifest.get("compose"), "canonical source_owner predecessor compose")
    if manager.get("version") != current_generation:
        _fail("canonical source_owner predecessor Manager version is wrong")
    if compose.get("sha256") != compat.get("compose_sha256"):
        _fail("canonical source_owner predecessor manifest does not bind its Compose bytes")
    images = _object(manifest.get("images"), "canonical source_owner predecessor images")
    expected_images = compat.get("managed_images")
    if not isinstance(expected_images, list) or sorted(images) != expected_images:
        _fail("canonical source_owner predecessor does not have the exact P1 image set")
    if any(
        not isinstance(image, str)
        or re.fullmatch(r"[^@\s]+@sha256:[0-9a-f]{64}", image) is None
        for image in images.values()
    ):
        _fail("canonical source_owner predecessor has an invalid image digest")
    return manifest


def _promotion_core(
    contract_path: Path,
    manifest_path: Path,
    challenge_schema_path: Path,
    receipt_schema_path: Path,
    generation: str,
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
    receipt_policy = contract["deployment_receipt"]
    required_receipt: str | None
    if stage == "source_owner":
        required_receipt = None
    elif stage == "bridge":
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
        "predecessor_generation": contract["predecessor_generation"],
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
) -> dict[str, Any]:
    result = _promotion_core(
        contract_path,
        manifest_path,
        challenge_schema_path,
        receipt_schema_path,
        generation,
    )
    result["sealed_assets"] = _sealed_assets(assets_root)
    _validate_sealed_assets(result["sealed_assets"], result["manifest_sha256"])
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
    sealed_assets = _validate_sealed_assets(
        promotion.get("sealed_assets"), promotion.get("manifest_sha256")
    )
    expected = _promotion_core(
        contract_path,
        manifest_path,
        challenge_schema_path,
        receipt_schema_path,
        generation,
    )
    expected["sealed_assets"] = (
        _sealed_assets(assets_root) if assets_root is not None else sealed_assets
    )
    _validate_sealed_assets(expected["sealed_assets"], expected["manifest_sha256"])
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


def _validate_transition_binding(
    candidate: dict[str, Any],
    current: dict[str, Any],
    *,
    label: str,
) -> None:
    for field in ("transition_id", "source_profile_id", "target_profile_id"):
        if candidate[field] != current[field]:
            _fail(f"{label} changes transition binding {field}")


def select_candidate(
    current_generation: str,
    candidates_root: Path,
    current_root: Path | None,
    current_compat_root: Path | None = None,
) -> dict[str, Any]:
    if COMMIT_RE.fullmatch(current_generation) is None:
        _fail("current generation must be a lowercase 40-character commit")
    current_promotion: dict[str, Any] | None = None
    if current_root is not None:
        current_promotion = validate_promotion(
            current_root / "promotion.json",
            current_root / "release-transition.json",
            current_root / "release.json",
            current_root / "release-transition-challenge.schema.json",
            current_root / "release-transition-receipt.schema.json",
            current_generation,
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
        promotion = validate_promotion(
            candidate_root / "promotion.json",
            candidate_root / "release-transition.json",
            candidate_root / "release.json",
            candidate_root / "release-transition-challenge.schema.json",
            candidate_root / "release-transition-receipt.schema.json",
            generation,
        )
        metadata = _load_metadata(candidate_root / "metadata.json", generation)
        candidate_contract = _load_contract(candidate_root / "release-transition.json")
        stage = promotion["stage"]
        if promotion["predecessor_generation"] != current_generation:
            continue
        if metadata["draft"] is not True:
            _fail(f"unpromoted {stage} release is not draft")
        if stage == "source_owner":
            if current_promotion is None:
                if current_compat_root is None:
                    _fail("source_owner requires the exact canonical P1 predecessor release")
                validate_source_owner_compat(
                    current_compat_root, candidate_contract, current_generation
                )
            else:
                if current_promotion["stage"] != "source_owner":
                    _fail("source_owner stabilization must directly follow source_owner")
                compat_generation = candidate_contract["source_owner_compat"][
                    "generation"
                ]
                if (
                    current_promotion["predecessor_generation"]
                    != compat_generation
                ):
                    _fail(
                        "source_owner stabilization is limited to the first "
                        "source_owner successor"
                    )
                _validate_transition_binding(
                    promotion,
                    current_promotion,
                    label="source_owner stabilization",
                )
        elif stage == "target_baseline":
            if current_promotion is None or current_promotion["stage"] not in TARGET_BASELINE_PREDECESSORS:
                _fail("target_baseline must directly follow cleanup or target_baseline")
            for field in ("transition_id", "target_profile_id"):
                if promotion[field] != current_promotion[field]:
                    _fail(f"target_baseline changes target transition binding {field}")
        else:
            expected_stage = STAGE_PREDECESSOR[stage]
            if current_promotion is None or current_promotion["stage"] != expected_stage:
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
    return {"action": "promote", "candidate": eligible[0]}


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
            command.add_argument("--output", type=Path, required=True)
        else:
            command.add_argument("--assets-root", type=Path)
            command.add_argument("--promotion", type=Path, required=True)

    select = commands.add_parser("select-candidate")
    select.add_argument("--current-generation", required=True)
    select.add_argument("--candidates-root", type=Path, required=True)
    select.add_argument("--current-root", type=Path)
    select.add_argument("--current-compat-root", type=Path)
    select.add_argument("--output", type=Path, required=True)

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
                arguments.current_compat_root,
            )
            _write_json(arguments.output, result)
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
