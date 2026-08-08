#!/usr/bin/env python3
"""Fetch and compare the private Sylver Platform Skill without vendoring it."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


SOURCE_NAME = "sylver_platform_skill"
EXPECTED_REPOSITORY_URL = (
    "https://github.com/Sylver-Lining/ubitech-platform-skill.git"
)
SKILL_PATH = "SKILL.md"
ADAPTER_PATH = "scripts/ubi.py"
CONTRACT_PATH = Path("docs/contracts/upstream-sources.json")
DEFAULT_TOKEN_RELATIVE_PATH = Path("agent-platform-secrets/sylver-skill-github.token")
DEFAULT_CHECKOUT_RELATIVE_PATH = Path("upstreams/sylver-platform-skill")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
REF_RE = re.compile(r"^refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]*$")


class SyncError(RuntimeError):
    pass


def _git(
    arguments: list[str],
    *,
    cwd: Path,
    environment: dict[str, str] | None = None,
    binary: bool = False,
    secrets: tuple[str, ...] = (),
) -> bytes | str:
    result = subprocess.run(
        ["git", *arguments],
        cwd=cwd,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=not binary,
        check=False,
    )
    if result.returncode != 0:
        raw_error = result.stderr.decode("utf-8", errors="replace") if binary else result.stderr
        message = str(raw_error or "git command failed").strip()
        for secret in secrets:
            if secret:
                message = message.replace(secret, "[redacted]")
        raise SyncError(message or f"git exited with status {result.returncode}")
    return result.stdout


def repository_root() -> Path:
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise SyncError("run this command from the Agent Platform Git repository")
    return Path(result.stdout.strip()).resolve()


def git_common_directory(root: Path) -> Path:
    value = str(_git(["rev-parse", "--git-common-dir"], cwd=root)).strip()
    path = Path(value)
    if not path.is_absolute():
        path = root / path
    resolved = path.resolve()
    if not resolved.is_dir():
        raise SyncError("Git metadata directory is unavailable")
    return resolved


def read_private_token(path: Path) -> str:
    try:
        before = path.lstat()
    except OSError as exc:
        raise SyncError(f"GitHub token file is unavailable: {path}") from exc
    if (
        not stat.S_ISREG(before.st_mode)
        or stat.S_ISLNK(before.st_mode)
        or before.st_uid != os.getuid()
        or before.st_mode & 0o077
        or before.st_size < 1
        or before.st_size > 4096
    ):
        raise SyncError("GitHub token file must be an owner-only regular file")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        try:
            opened = os.fstat(descriptor)
            if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                raise SyncError("GitHub token file changed while it was opened")
            raw = os.read(descriptor, 4097)
        finally:
            os.close(descriptor)
    except OSError as exc:
        raise SyncError("GitHub token file could not be opened safely") from exc
    if len(raw) > 4096:
        raise SyncError("GitHub token file is too large")
    try:
        token = raw.decode("utf-8").strip()
    except UnicodeDecodeError as exc:
        raise SyncError("GitHub token file is not UTF-8") from exc
    if not token or any(character.isspace() or ord(character) < 32 for character in token):
        raise SyncError("GitHub token file contains an invalid token")
    return token


def load_source_contract(root: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    path = root / CONTRACT_PATH
    try:
        contract = json.loads(path.read_text(encoding="utf-8"))
        source = contract["sources"][SOURCE_NAME]
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise SyncError("Sylver Platform upstream source contract is invalid") from exc
    if not isinstance(contract, dict) or not isinstance(source, dict):
        raise SyncError("Sylver Platform upstream source contract is invalid")
    url = source.get("repository_url")
    parsed = urlsplit(url) if isinstance(url, str) else None
    if parsed is None or url != EXPECTED_REPOSITORY_URL:
        raise SyncError("Sylver Platform repository URL must be the fixed official URL")
    revision = source.get("revision")
    digest = source.get("skill_sha256")
    adapter_digest = source.get("adapter_sha256")
    tracking_ref = source.get("tracking_ref")
    if not isinstance(revision, str) or not COMMIT_RE.fullmatch(revision):
        raise SyncError("Sylver Platform revision must be a pinned commit")
    if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
        raise SyncError("Sylver Platform Skill digest is invalid")
    if not isinstance(adapter_digest, str) or not SHA256_RE.fullmatch(adapter_digest):
        raise SyncError("Sylver Platform adapter digest is invalid")
    if (
        not isinstance(tracking_ref, str)
        or not REF_RE.fullmatch(tracking_ref)
        or ".." in tracking_ref
        or tracking_ref.endswith(("/", ".lock"))
    ):
        raise SyncError("Sylver Platform tracking ref is invalid")
    required_paths = source.get("required_paths")
    if (
        not isinstance(required_paths, list)
        or set((SKILL_PATH, ADAPTER_PATH)) - set(required_paths)
    ):
        raise SyncError(
            "Sylver Platform source contract must require SKILL.md and scripts/ubi.py"
        )
    return contract, source


def git_auth_environment(token: str) -> tuple[dict[str, str], str]:
    encoded = base64.b64encode(f"x-access-token:{token}".encode("utf-8")).decode("ascii")
    header = f"Authorization: Basic {encoded}"
    environment = dict(os.environ)
    environment.update(
        {
            "GIT_CONFIG_COUNT": "3",
            "GIT_CONFIG_KEY_0": "http.extraHeader",
            "GIT_CONFIG_VALUE_0": header,
            "GIT_CONFIG_KEY_1": "http.followRedirects",
            "GIT_CONFIG_VALUE_1": "false",
            "GIT_CONFIG_KEY_2": "credential.helper",
            "GIT_CONFIG_VALUE_2": "",
            "GIT_TERMINAL_PROMPT": "0",
            "GCM_INTERACTIVE": "Never",
        }
    )
    return environment, header


def _owned_directory(path: Path, *, create: bool = False) -> None:
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        metadata = path.lstat()
    except OSError as exc:
        raise SyncError(f"local upstream directory is unavailable: {path}") from exc
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise SyncError(f"local upstream path is not a real directory: {path}")
    if metadata.st_uid != os.getuid():
        raise SyncError(f"local upstream directory has the wrong owner: {path}")
    if metadata.st_mode & 0o077:
        try:
            path.chmod(0o700)
        except OSError as exc:
            raise SyncError(f"local upstream directory is not owner-only: {path}") from exc


def fetch_upstream(
    git_directory: Path,
    source: dict[str, Any],
    token: str,
) -> tuple[str, bytes, bytes, str]:
    upstream_root = git_directory / DEFAULT_CHECKOUT_RELATIVE_PATH.parent
    _owned_directory(upstream_root, create=True)
    checkout = git_directory / DEFAULT_CHECKOUT_RELATIVE_PATH
    environment, header = git_auth_environment(token)
    secrets = (token, header, header.removeprefix("Authorization: Basic "))
    repository_url = str(source["repository_url"])
    if checkout.exists():
        _owned_directory(checkout)
        origin = str(
            _git(["config", "--get", "remote.origin.url"], cwd=checkout)
        ).strip()
        if origin != repository_url:
            raise SyncError("local Sylver Platform checkout has an unexpected origin")
    else:
        _git(
            ["clone", "--no-checkout", repository_url, str(checkout)],
            cwd=upstream_root,
            environment=environment,
            secrets=secrets,
        )
        _owned_directory(checkout)
    tracking_ref = str(source["tracking_ref"])
    local_tracking_ref = "refs/remotes/origin/agent-platform-reviewed-upstream"
    _git(
        [
            "fetch",
            "--no-tags",
            "--prune",
            "origin",
            f"+{tracking_ref}:{local_tracking_ref}",
        ],
        cwd=checkout,
        environment=environment,
        secrets=secrets,
    )
    upstream_revision = str(
        _git(
            ["rev-parse", f"{local_tracking_ref}^{{commit}}"],
            cwd=checkout,
            environment=environment,
            secrets=secrets,
        )
    ).strip()
    if not COMMIT_RE.fullmatch(upstream_revision):
        raise SyncError("fetched upstream revision is invalid")
    for required in source["required_paths"]:
        _git(
            ["cat-file", "-e", f"{upstream_revision}:{required}"],
            cwd=checkout,
            environment=environment,
            secrets=secrets,
        )
    skill = _git(
        ["show", f"{upstream_revision}:{SKILL_PATH}"],
        cwd=checkout,
        environment=environment,
        binary=True,
        secrets=secrets,
    )
    assert isinstance(skill, bytes)
    adapter = _git(
        ["show", f"{upstream_revision}:{ADAPTER_PATH}"],
        cwd=checkout,
        environment=environment,
        binary=True,
        secrets=secrets,
    )
    assert isinstance(adapter, bytes)
    locked_revision = str(source["revision"])
    stat_summary = ""
    try:
        stat_summary = str(
            _git(
                [
                    "diff", "--stat", locked_revision, upstream_revision, "--",
                    *source["required_paths"],
                ],
                cwd=checkout,
                environment=environment,
                secrets=secrets,
            )
        ).strip()
    except SyncError:
        stat_summary = "locked revision is not present in the local upstream cache"
    return upstream_revision, skill, adapter, stat_summary


def update_reviewed_lock(
    root: Path,
    contract: dict[str, Any],
    *,
    revision: str,
    skill_digest: str,
    adapter_digest: str,
) -> None:
    source = contract["sources"][SOURCE_NAME]
    source["revision"] = revision
    source["skill_sha256"] = skill_digest
    source["adapter_sha256"] = adapter_digest
    target = root / CONTRACT_PATH
    serialized = json.dumps(contract, ensure_ascii=False, indent=2) + "\n"
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.", dir=target.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(serialized)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.chmod(0o644)
        os.replace(temporary, target)
        directory_fd = os.open(target.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


def parse_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch and compare the private Sylver Platform Skill."
    )
    parser.add_argument(
        "--accept-reviewed-revision",
        metavar="COMMIT",
        help="update the canonical lock only when this exact fetched commit was reviewed",
    )
    parser.add_argument(
        "--require-current",
        action="store_true",
        help="exit nonzero when upstream differs from the reviewed lock",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    arguments = parse_arguments(argv)
    try:
        root = repository_root()
        git_directory = git_common_directory(root)
        contract, source = load_source_contract(root)
        token_path = git_directory / DEFAULT_TOKEN_RELATIVE_PATH
        token = read_private_token(token_path)
        revision, skill, adapter, stat_summary = fetch_upstream(
            git_directory, source, token
        )
        token = ""
        digest = hashlib.sha256(skill).hexdigest()
        adapter_digest = hashlib.sha256(adapter).hexdigest()
        locked_revision = str(source["revision"])
        locked_digest = str(source["skill_sha256"])
        locked_adapter_digest = str(source["adapter_sha256"])
        changed = (
            revision != locked_revision
            or digest != locked_digest
            or adapter_digest != locked_adapter_digest
        )
        if arguments.accept_reviewed_revision is not None:
            accepted = str(arguments.accept_reviewed_revision)
            if not COMMIT_RE.fullmatch(accepted) or accepted != revision:
                raise SyncError(
                    "accepted revision must exactly match the fetched upstream commit"
                )
            update_reviewed_lock(
                root,
                contract,
                revision=revision,
                skill_digest=digest,
                adapter_digest=adapter_digest,
            )
        report = {
            "source": SOURCE_NAME,
            "locked_revision": locked_revision,
            "upstream_revision": revision,
            "locked_skill_sha256": locked_digest,
            "upstream_skill_sha256": digest,
            "locked_adapter_sha256": locked_adapter_digest,
            "upstream_adapter_sha256": adapter_digest,
            "changed": changed,
            "diff_stat": stat_summary,
            "lock_updated": arguments.accept_reviewed_revision is not None,
        }
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 1 if arguments.require_current and changed else 0
    except SyncError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
