#!/usr/bin/env python3
"""Generate cross-language constants and check local Markdown links."""
from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Sequence
from urllib.parse import unquote, urlsplit

ENTRY_MARKDOWN_PATHS = (
    "AGENTS.md",
    "README.md",
    "enterprise-agent-platform/README.md",
    "enterprise-agent-platform/agent-runtime/README.md",
)


class DocsSyncError(RuntimeError):
    """Raised when the documentation contract is malformed or out of sync."""


@dataclass(frozen=True)
class ContractTarget:
    path: str
    format: str


@dataclass(frozen=True)
class Contract:
    identifier: str
    source: str
    targets: tuple[ContractTarget, ...]


def _targets(*pairs: tuple[str, str]) -> tuple[ContractTarget, ...]:
    return tuple(ContractTarget(path=path, format=target_format) for path, target_format in pairs)


# The complete, closed set of machine contracts. Each source lives under
# docs/contracts/ and is rendered byte-for-byte into every listed consumer.
CONTRACTS: tuple[Contract, ...] = (
    Contract(
        identifier="container-platform",
        source="docs/contracts/container-platform.json",
        targets=_targets(
            ("manager/internal/contract/generated.go", "go-container-platform"),
            ("enterprise-agent-platform/enterprise_agent_platform/container_contract_generated.py", "python-container-platform"),
            ("enterprise-agent-platform/agent-runtime/src/container-contract.generated.ts", "typescript-container-platform"),
            ("enterprise-agent-platform/frontend/src/container-contract.generated.ts", "typescript-container-platform"),
        ),
    ),
    # Build scripts read this JSON directly; nothing is generated.
    Contract(
        identifier="upstream-sources",
        source="docs/contracts/upstream-sources.json",
        targets=(),
    ),
    Contract(
        identifier="technical-profiles",
        source="docs/contracts/technical-profiles.json",
        targets=_targets(
            ("manager/internal/identity/technical_profiles_generated.go", "go-technical-profiles"),
            ("enterprise-agent-platform/enterprise_agent_platform/technical_profile_generated.py", "python-technical-profiles"),
            ("enterprise-agent-platform/agent-runtime/src/technical-profile.generated.ts", "typescript-technical-profile"),
        ),
    ),
    Contract(
        identifier="runtime-policy",
        source="docs/contracts/runtime-policy.json",
        targets=_targets(
            ("manager/internal/executor/runtime_policy_generated.go", "go-runtime-policy"),
            ("enterprise-agent-platform/enterprise_agent_platform/design_contract_generated.py", "python-runtime-policy"),
            ("enterprise-agent-platform/agent-runtime/src/design-contract.generated.ts", "typescript-runtime-policy"),
            ("enterprise-agent-platform/frontend/src/design-contract.generated.ts", "typescript-runtime-policy"),
        ),
    ),
)


def _relative_path(relative: str) -> PurePosixPath:
    if not isinstance(relative, str) or not relative or "\\" in relative:
        raise DocsSyncError(f"invalid repository-relative path: {relative!r}")
    candidate = PurePosixPath(relative)
    if candidate.is_absolute() or ".." in candidate.parts or candidate.as_posix() != relative:
        raise DocsSyncError(f"unsafe repository-relative path: {relative!r}")
    return candidate


def _safe_path(root: Path, relative: str) -> Path:
    candidate = _relative_path(relative)
    lexical = root / Path(*candidate.parts)
    try:
        resolved_root = root.resolve()
        resolved = lexical.resolve()
    except (OSError, RuntimeError) as exc:
        raise DocsSyncError(
            f"could not safely resolve repository-relative path {relative!r}: {exc}"
        ) from exc
    if resolved != resolved_root and resolved_root not in resolved.parents:
        raise DocsSyncError(f"path escapes repository root: {relative!r}")
    return lexical


def _reject_symlink_chain(root: Path, relative: str, label: str) -> Path:
    path = _safe_path(root, relative)
    current = root
    for part in PurePosixPath(relative).parts:
        current = current / part
        try:
            current_stat = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(current_stat.st_mode):
            raise DocsSyncError(f"{label} must not use symlinks: {relative}")
    return path


def _require_regular_file(path: Path, label: str, relative: str) -> None:
    try:
        path_stat = path.lstat()
    except FileNotFoundError as exc:
        raise DocsSyncError(f"{label} is missing: {relative}") from exc
    if not stat.S_ISREG(path_stat.st_mode):
        raise DocsSyncError(f"{label} must be a regular file: {relative}")


def read_strict_json(path: Path, label: str) -> Any:
    """Read JSON while rejecting duplicate object members.

    Signed and release-critical inputs cannot use the ordinary
    last-member-wins behavior of ``json.loads``.
    """

    def object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise DocsSyncError(f"{label} contains duplicate key: {key}")
            result[key] = value
        return result

    try:
        return json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=object_pairs,
            parse_constant=lambda value: (_ for _ in ()).throw(
                ValueError(f"non-finite number {value}")
            ),
        )
    except FileNotFoundError as exc:
        raise DocsSyncError(f"{label} is missing: {path}") from exc
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
        raise DocsSyncError(f"{label} is not strict JSON: {exc}") from exc


def _lookup(value: dict, path: str):
    for key in path.split('.'):
        value = value[key]
    return value


def _camel(name: str) -> str:
    return ''.join(part.title() for part in name.split('_'))


def _literal(value, language: str) -> str:
    if language == 'python':
        return repr(tuple(value) if isinstance(value, list) else value)
    return json.dumps(value, ensure_ascii=False, indent=2 if isinstance(value, dict) else None)


def _constants(values: list[tuple[str, object]], language: str, *, package: str = '') -> str:
    """The three consumers differ only in declaration syntax and string literals."""
    if language == 'go':
        width = max(len(name) for name, _ in values)
        lines = [f'\t{name:<{width}} = {_literal(value, language)}' for name, value in values]
        return f'package {package}\n\nconst (\n' + '\n'.join(lines) + '\n)\n'
    lines = []
    for name, value in values:
        if not name:
            lines.append('')
            continue
        literal = _literal(value, language)
        lines.append(f'{name} = {literal}' if language == 'python' else f'export const {name} = {literal} as const;')
        if language == 'typescript' and name in TYPESCRIPT_TYPES:
            lines.append(f'export type {TYPESCRIPT_TYPES[name]} = (typeof {name})[number];')
    prefix = 'from __future__ import annotations\n\n' if language == 'python' else ''
    return prefix + '\n'.join(lines) + '\n'


TYPESCRIPT_TYPES = {
    'EXECUTION_TARGETS': 'ExecutionTarget',
    'PUBLIC_UPDATE_STATES': 'PublicUpdateState',
    'MANAGER_OPERATIONS': 'ManagerOperation',
    'MANAGER_OPERATION_PHASES': 'ManagerOperationPhase',
}
CONTAINER_FIELDS = (
    ('CONTAINER_PLATFORM_SCHEMA_VERSION', 'schema_version'),
    ('RELEASE_CHANNEL', 'release_channel'),
    ('DATABASE_SCHEMA_VERSION', 'database_schema_version'),
    ('CONTAINER_PATHS', 'container_paths'),
    ('EXECUTION_TARGETS', 'execution_targets'),
    ('PERSISTENT_DATA_OWNERS', 'persistent_data_owners'),
    ('SANDBOX_IDLE_SECONDS', 'sandbox_idle_seconds'),
    ('MIGRATION_BACKUP_RETENTION_SECONDS', 'migration_backup_retention_seconds'),
    ('OBSOLETE_ARTIFACT_RETENTION_SECONDS', 'obsolete_artifact_retention_seconds'),
    ('UPDATE_PRE_DOWNLOAD_MIN_FREE_BYTES', 'update_pre_download_min_free_bytes'),
    ('UPDATE_PRE_CUTOVER_MIN_FREE_BYTES', 'update_pre_cutover_min_free_bytes'),
    ('UPDATE_MIN_FREE_INODES', 'update_min_free_inodes'),
    ('MANAGED_IMAGE_CAPACITY_ESTIMATES', 'managed_image_capacity_estimates'),
    ('PUBLIC_UPDATE_STATES', 'public_update_states'),
    ('MANAGER_OPERATIONS', 'operations'),
    ('MANAGER_OPERATION_PHASES', 'operation_phases'),
)
GO_PROFILE_FIELDS = {
    'ProfileID': 'profile_id',
    'ManagerBinary': 'manager.binary',
    'ManagerUnit': 'manager.unit',
    'ConfigDirectory': 'manager.config_directory',
    'ConfigFile': 'manager.config_file',
    'DataDirectory': 'manager.data_directory',
    'ManagerStateDirectory': 'manager.state_directory',
    'RuntimeSocketPath': 'manager.runtime_socket_path',
    'ContainerDataRoot': 'container.data_root',
    'ContainerSecretRoot': 'container.secret_root',
    'ContainerControlSocketPath': 'container.control_socket_path',
    'GatewayStatusPath': 'gateway.status_path',
    'GatewayHealthPath': 'gateway.health_path',
    'ComposeProject': 'compose.project',
    'CoreNetwork': 'compose.core_network',
    'EnvironmentPrefix': 'environment.manager_prefix',
    'LabelPrefix': 'labels.prefix',
    'SandboxContainerPrefix': 'labels.sandbox_container_prefix',
    'MigrationContainerPrefix': 'labels.migration_container_prefix',
    'WatchdogUnitPrefix': 'labels.watchdog_unit_prefix',
    'RecoveryWatchdogUnitPrefix': 'labels.recovery_watchdog_unit_prefix',
    'InternalWorkspaceDirectory': 'workspace.internal_directory',
}
PYTHON_PROFILE_FIELDS = {
    'profile_id': 'profile_id',
    'selector_environment_variable': 'environment.keys.technical_profile',
    'deployment_mode_environment_variable': 'environment.keys.deployment_mode',
    'manager_socket_environment_variable': 'environment.keys.manager_socket',
    'manager_token_file_environment_variable': 'environment.keys.manager_token_file',
    'host_data_root_environment_variable': 'environment.keys.host_data_root',
    'manager_environment_prefix': 'environment.manager_prefix',
    'platform_environment_prefix': 'environment.platform_prefix',
    'default_data_root': 'platform.default_data_root',
    'default_manager_socket': 'manager.default_socket_path',
    'default_manager_token_file': 'manager.default_token_file',
    'database_baseline_name': 'platform.database_baseline',
    'instance_lock_name': 'platform.instance_lock',
    'scope_marker_name': 'workspace.scope_marker',
    'camofox_sidecar_name': 'platform.camofox_sidecar',
    'workspace_internal_directory': 'workspace.internal_directory',
    'session_namespace': 'platform.session_namespace',
    'session_cookie_name': 'platform.session_cookie',
    'health_service': 'platform.health_service',
    'search_health_service': 'platform.search_health_service',
    'agent_runtime_health_service': 'platform.agent_runtime_health_service',
}
TS_PROFILE_FIELDS = {
    'TARGET_TECHNICAL_PROFILE_ID': 'profile_id',
    'TARGET_TECHNICAL_PROFILE_ENVIRONMENT_VARIABLE': 'environment.keys.technical_profile',
    'TARGET_MANAGER_EXECUTOR_SOCKET_PATH': 'manager.default_socket_path',
}
RUNTIME_GROUPS = {
    'run_idle_timeout': ('_seconds', 0, ((1 << 53) - 1) // 1000),
    'max_turns_per_run': ('', 1, (1 << 53) - 1),
    'terminal_timeout': ('_milliseconds', 1, 2_147_483_647),
    'process_wait_timeout': ('_milliseconds', 1, 2_147_483_647),
}


def _runtime_values(data: dict, language: str) -> list[tuple[str, object]]:
    values = [('RUNTIME_POLICY_SCHEMA_VERSION', data['schema_version'])]
    for group, (suffix, minimum, maximum) in RUNTIME_GROUPS.items():
        policy = data[group]
        bounds = [policy[key + suffix] for key in ('minimum', 'default', 'maximum')]
        if any(type(value) is not int for value in bounds) or not minimum <= bounds[0] <= bounds[1] <= bounds[2] <= maximum:
            raise DocsSyncError(f'{group}: invalid minimum/default/maximum bounds (allowed {minimum}..{maximum})')
        if language != 'go':
            values.append(('', None))
        for key in ('default', 'minimum', 'maximum', 'platform_environment_variable', 'runtime_environment_variable'):
            field = key + suffix if key in ('default', 'minimum', 'maximum') else key
            if field in policy and not (language == 'go' and key.endswith('environment_variable')):
                values.append((f'{group}_{field}'.upper(), policy[field]))
    if language == 'go':
        values = [(name[0].lower() + name[1:], value) for key, value in values for name in [_camel(key)]]
    return values


def _container_go(data: dict) -> str:
    values = [('SchemaVersion', data['schema_version']), ('ReleaseChannel', data['release_channel']), ('DatabaseSchemaVersion', data['database_schema_version'])]
    values.extend(('Container' + _camel(key), value) for key, value in data['container_paths'].items())
    values.extend((_camel(name), data[path]) for name, path in CONTAINER_FIELDS[6:12])
    text = _constants(values, 'go', package='contract')
    text += '\ntype ImageCapacityEstimate struct {\n\tCompressedBytes uint64\n\tUnpackedBytes   uint64\n}\n\nvar ManagedImageCapacityEstimates = map[string]ImageCapacityEstimate{\n'
    for name, value in sorted(data['managed_image_capacity_estimates'].items()):
        text += f'\t{json.dumps(name)}: {{\n\t\tCompressedBytes: {value["compressed_bytes"]},\n\t\tUnpackedBytes:   {value["unpacked_bytes"]},\n\t}},\n'
    text += '}\n\ntype PersistentDataOwner struct {\n\tUID uint32\n\tGID uint32\n}\n\nvar PersistentDataOwners = map[string][]PersistentDataOwner{\n'
    owners = data['persistent_data_owners']
    width = max(len(json.dumps(name)) for name in owners)
    for name, identities in sorted(owners.items()):
        records = ', '.join(f'{{UID: {owner["uid"]}, GID: {owner["gid"]}}}' for owner in identities)
        text += f'\t{json.dumps(name) + ":":<{width + 1}} {{{records}}},\n'
    return text + '}\n'


def _profile(data: dict, language: str) -> str:
    profile = data['profiles']['target']
    if language == 'typescript':
        return _constants([(name, _lookup(profile, path)) for name, path in TS_PROFILE_FIELDS.items()], language)
    if language == 'python':
        lines = ''.join(f'        {name!r}: {_lookup(profile, path)!r},\n' for name, path in PYTHON_PROFILE_FIELDS.items())
        return "from __future__ import annotations\n\nTECHNICAL_PROFILES: dict[str, dict[str, object]] = {\n    'target': {\n" + lines + '    },\n}\n'
    width = max(map(len, GO_PROFILE_FIELDS)) + 1
    lines = ''.join(f'\t{name + ":":<{width}} {json.dumps(_lookup(profile, path) or "", ensure_ascii=False)},\n' for name, path in GO_PROFILE_FIELDS.items())
    return 'package identity\n\nvar generatedTargetProfile = Profile{\n' + lines + '}\n'


def render_contract(root: Path, contract: Contract) -> dict[str, str]:
    source = _reject_symlink_chain(root, contract.source, 'contract source')
    _require_regular_file(source, 'contract source', contract.source)
    data = read_strict_json(source, contract.identifier)
    rendered = {}
    try:
        for target in contract.targets:
            language = target.format.split('-', 1)[0]
            if contract.identifier == 'runtime-policy':
                body = _constants(_runtime_values(data, language), language, package='executor')
            elif contract.identifier == 'container-platform':
                body = _container_go(data) if language == 'go' else _constants([(name, data[path]) for name, path in CONTAINER_FIELDS], language)
            elif contract.identifier == 'technical-profiles':
                body = _profile(data, language)
            else:
                raise DocsSyncError(f'unsupported contract: {contract.identifier}')
            banner = f'Generated from {contract.source} by scripts/docs_sync.py; do not edit.'
            if language == 'go':
                banner = f'Code generated from {contract.source} by scripts/docs_sync.py; DO NOT EDIT.'
            rendered[target.path] = ('# ' if language == 'python' else '// ') + banner + '\n' + body
    except (KeyError, TypeError, ValueError) as exc:
        raise DocsSyncError(f'{contract.source}: cannot generate contract: {exc}') from exc
    return rendered


def _atomic_write(root: Path, relative: str, content: str) -> None:
    path = _reject_symlink_chain(root, relative, "generated contract target")
    if path.exists() and not stat.S_ISREG(path.lstat().st_mode):
        raise DocsSyncError(f"generated contract target must be a regular file: {relative}")
    path.parent.mkdir(parents=True, exist_ok=True)
    _reject_symlink_chain(root, relative, "generated contract target")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
            os.fchmod(handle.fileno(), 0o644)
        _reject_symlink_chain(root, relative, "generated contract target")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _markdown_without_fenced_code(text: str) -> str:
    kept: list[str] = []
    fence: str | None = None
    for line in text.splitlines():
        stripped = line.lstrip()
        marker = "```" if stripped.startswith("```") else "~~~" if stripped.startswith("~~~") else None
        if fence is None and marker:
            fence = marker
            continue
        if fence is not None:
            if stripped.startswith(fence):
                fence = None
            continue
        kept.append(line)
    return "\n".join(kept)


def _heading_anchors(text: str) -> set[str]:
    """GitHub-style heading anchors: lowercase, drop punctuation, spaces become hyphens, duplicates get -N."""
    anchors: set[str] = set()
    counts: dict[str, int] = {}
    for line in text.splitlines():
        match = re.match(r"^(#{1,6})[ \t]+(.+?)[ \t#]*$", line)
        if match is None:
            continue
        slug = re.sub(r"[^\w\- ]", "", match.group(2).strip().lower()).replace(" ", "-")
        seen = counts.get(slug, 0)
        counts[slug] = seen + 1
        anchors.add(slug if seen == 0 else f"{slug}-{seen}")
    return anchors


def _sync(root: Path, *, check: bool) -> list[str]:
    results = []
    for contract in CONTRACTS:
        for relative, content in render_contract(root, contract).items():
            target = _reject_symlink_chain(root, relative, 'generated contract target')
            if target.exists():
                _require_regular_file(target, 'generated contract target', relative)
                current = target.read_bytes()
                mode = stat.S_IMODE(target.stat().st_mode)
            else:
                current, mode = None, None
            if current == content.encode('utf-8') and (not mode & 0o111 if check else mode == 0o644):
                continue
            if check:
                results.append(f'generated contract target is missing, stale or executable: {relative}; run scripts/docs_sync.py sync')
            else:
                _atomic_write(root, relative, content)
                results.append(relative)
    return results


def sync_contracts(root: Path) -> tuple[str, ...]:
    return tuple(_sync(root, check=False))


def validate_markdown_links(root: Path) -> list[str]:
    errors = []
    docs = _safe_path(root, 'docs')
    if not docs.is_dir():
        return ['canonical documentation directory is missing: docs/']
    documents = set(docs.rglob('*.md'))
    for relative in ENTRY_MARKDOWN_PATHS:
        entry = _safe_path(root, relative)
        if entry.is_file():
            documents.add(entry)
        else:
            errors.append(f'documentation entry point is missing: {relative}')
    anchors = {}
    root = root.resolve()
    for document in sorted(documents):
        label = document.relative_to(root)
        if document.is_symlink():
            errors.append(f'documentation file must not be a symlink: {label}')
            continue
        text = _markdown_without_fenced_code(document.read_text(encoding='utf-8'))
        for raw in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)', text):
            link = raw.strip()
            if not link:
                continue
            link = link[1:link.index('>')] if link.startswith('<') and '>' in link else link.split()[0]
            parts = urlsplit(link)
            if parts.scheme or parts.netloc:
                continue
            path, fragment = unquote(parts.path), unquote(parts.fragment)
            target = ((root / path.lstrip('/')) if path.startswith('/') else (document.parent / path)) if path else document
            target = target.resolve()
            if not target.is_relative_to(root):
                errors.append(f'{label} links outside the repository: {raw}')
            elif not target.exists():
                errors.append(f'{label} has a broken relative link: {raw}')
            elif fragment and target.suffix == '.md' and target.is_file():
                if target not in anchors:
                    anchors[target] = _heading_anchors(_markdown_without_fenced_code(target.read_text(encoding='utf-8')))
                if fragment.lower() not in anchors[target]:
                    errors.append(f'{label} links to a missing heading anchor: {raw}')
    return errors


def validate_current_tree(root: Path) -> list[str]:
    return _sync(root, check=True) + validate_markdown_links(root)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('sync', 'check'):
        commands.add_parser(name).add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args(argv)
    try:
        if args.command == 'sync':
            written = sync_contracts(args.root.resolve())
            print('updated generated contracts: ' + ', '.join(written) if written else 'generated design contracts are already current')
            return 0
        errors = validate_current_tree(args.root.resolve())
    except (DocsSyncError, OSError, UnicodeError, ValueError) as exc:
        errors = [str(exc)]
    if errors:
        print('documentation sync check failed:', file=sys.stderr)
        for error in errors:
            print(f'  - {error}', file=sys.stderr)
        return 1
    print('generated contracts and documentation links are in sync')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
