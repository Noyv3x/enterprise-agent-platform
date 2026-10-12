"""Agent Skills: discovery, validation, installation, per-scope catalogs, `/name` invocation and the skill APIs.

A skill is a directory with a `SKILL.md`. Files on disk are the source of truth for content; the `skills` table only
records provenance (and group assignment for organization skills). Three tiers exist: built-in (image directory),
organization (`<data_dir>/skills/org`, written here) and personal/channel (`<workspace>/.agent-platform/skills`).
"""
import asyncio
import ctypes
import errno
import io
import json
import logging
import os
import posixpath
import re
import secrets
import shutil
import stat
import tarfile
import tempfile
import time
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import yaml
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.routing import Route

from .auth import body_json, current_user, groups, permissions, require_permission
from .files import ensure_workspace, open_workspace
from .tools import download

log = logging.getLogger(__name__)

MAX_DOWNLOAD = 50 * 1024 * 1024
MAX_UNPACKED = 50 * 1024 * 1024
MAX_FILES = 2000
MAX_SKILL_MD = 256 * 1024
MAX_DESCRIPTION = 1024
MAX_NAME = 64
MAX_CANDIDATES = 50
NAME = re.compile(r'[a-z0-9]+(-[a-z0-9]+)*')
INVOKE = re.compile(r'\s*/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?=\s|$)')
BUILTIN_LOCATION = '/opt/agent-platform/skills/builtin'
ORG_LOCATION = '/opt/agent-platform/skills/org'
WORKSPACE_LOCATION = '/workspace/.agent-platform/skills'
WORKSPACE_REL = '.agent-platform/skills'
DISABLED_BUILTIN_KEY = 'builtin_skills_disabled_v1'
INSTALL = 'install_extensions'
KNOWN_FIELDS = ('name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools',
                'disable-model-invocation', 'version', 'category', 'tags')
_RENAME_NOREPLACE, _RENAME_EXCHANGE = 1, 2


class SkillError(HTTPException):
    """A typed skill failure. `payload` entries are merged into the API error body and the tool's error data."""

    def __init__(self, status, code, detail, **payload):
        super().__init__(status, detail)
        self.code = code
        self.payload = payload


# -- frontmatter ----------------------------------------------------------------------------------

def split_frontmatter(text):
    """`(raw frontmatter text or None, body)`; the block must open on the first line and close with a `---` line."""
    text = text.removeprefix('\ufeff')
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].rstrip() != '---':
        return None, text
    for index in range(1, len(lines)):
        if lines[index].rstrip() == '---':
            return ''.join(lines[1:index]), ''.join(lines[index + 1:])
    return None, text


def _lenient_frontmatter(raw):
    """Top-level `key: value` lines, for frontmatter that is not valid YAML (typically an unquoted colon)."""
    meta = {}
    for line in raw.splitlines():
        match = re.match(r'^([A-Za-z][\w-]*)\s*:\s*(.*)$', line)
        if match:
            meta[match[1]] = match[2].strip().strip('"\'')
    return meta


def normalize_name(value):
    return re.sub(r'[^a-z0-9]+', '-', str(value).lower()).strip('-')


def parse_skill(text, fallback_name, strict):
    """Parse SKILL.md metadata. Lenient (discovery) falls back to the directory name and returns a None description
    when it is missing; strict (install) raises a typed error for any rule violation."""
    warnings = []
    raw, body = split_frontmatter(text)
    meta = {}
    if raw is not None:
        try:
            loaded = yaml.safe_load(raw)
            if loaded is None:
                loaded = {}
            if not isinstance(loaded, dict):
                raise yaml.YAMLError('frontmatter is not a mapping')
            meta = loaded
        except yaml.YAMLError:
            meta = _lenient_frontmatter(raw)
            warnings.append('Frontmatter is not valid YAML; it was read leniently')
    elif strict:
        raise SkillError(400, 'skill_invalid', 'SKILL.md needs YAML frontmatter with name and description')
    meta = {str(key): value for key, value in meta.items()}
    given = meta.get('name')
    if strict and (not isinstance(given, str) or not given.strip()):
        raise SkillError(400, 'skill_invalid', 'SKILL.md frontmatter needs a name')
    present = isinstance(given, (str, int, float)) and not isinstance(given, bool) and str(given).strip()
    name = normalize_name(given if present else fallback_name)
    if not name and not strict:
        name = normalize_name(fallback_name)
    if strict and (not name or len(name) > MAX_NAME):
        raise SkillError(400, 'skill_invalid', f'Skill name must normalize to 1-{MAX_NAME} characters of a-z, 0-9 and hyphens')
    if not strict and (not name or len(name) > MAX_NAME):
        warnings.append('Skill name is invalid')
        name = ''
    elif isinstance(given, str) and given.strip() != name:
        warnings.append(f'Name "{given.strip()}" was normalized to "{name}"')
    description = meta.get('description')
    description = str(description).strip() if description is not None and not isinstance(description, (dict, list)) else ''
    if not description:
        if strict:
            raise SkillError(400, 'skill_invalid', 'SKILL.md frontmatter needs a description')
        warnings.append('Missing description')
        description = None
    elif len(description) > MAX_DESCRIPTION:
        if strict:
            raise SkillError(400, 'skill_invalid', f'Description exceeds {MAX_DESCRIPTION} characters')
        warnings.append(f'Description was truncated to {MAX_DESCRIPTION} characters')
        description = description[:MAX_DESCRIPTION]
    version = meta.get('version')
    if version is None and isinstance(meta.get('metadata'), dict):
        version = meta['metadata'].get('version')
    hidden = meta.get('disable-model-invocation')
    hidden = hidden is True or (isinstance(hidden, str) and hidden.strip().lower() == 'true')
    known = json.loads(json.dumps({key: meta[key] for key in KNOWN_FIELDS if key in meta}, default=str))
    return {'name': name, 'description': description, 'version': str(version) if version is not None else None,
            'hidden': hidden, 'warnings': warnings, 'frontmatter': known, 'body': body}


# -- discovery ------------------------------------------------------------------------------------

@dataclass
class Skill:
    tier: str                      # builtin | org | personal | channel
    name: str
    dirname: str
    description: str
    root: Path                     # open_workspace root of the skill directory
    rel: str                       # directory relative to root
    location: str                  # sandbox path of SKILL.md
    key: str
    version: str | None = None
    hidden: bool = False
    warnings: list = field(default_factory=list)
    source: dict | None = None
    updated_at: str | None = None
    enabled: bool = True
    frontmatter: dict = field(default_factory=dict)

    @property
    def directory(self):
        return posixpath.dirname(self.location)


def _read_skill_md(root, rel):
    """`(text, mtime)` of `<rel>/SKILL.md` read through pinned descriptors; None when unreadable or too large."""
    try:
        fd = open_workspace(root, posixpath.join(rel, 'SKILL.md'))
    except (OSError, HTTPException):
        return None
    with os.fdopen(fd, 'rb') as stream:
        mtime = os.fstat(stream.fileno()).st_mtime
        data = stream.read(MAX_SKILL_MD + 1)
    if len(data) > MAX_SKILL_MD:
        return None
    try:
        return data.decode('utf-8'), mtime
    except UnicodeError:
        return None


def _list_dir(root, rel):
    try:
        fd = open_workspace(root, rel, directory=True)
    except (OSError, HTTPException):
        return []
    try:
        return sorted(os.listdir(fd))
    finally:
        os.close(fd)


def _iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat() if value is not None else None


def list_files(root, rel, limit=MAX_FILES):
    """`[{path, size_bytes}]` of regular files below `<root>/<rel>`; links and special files are skipped."""
    found = []

    def visit(directory):
        try:
            fd = open_workspace(root, posixpath.join(rel, directory), directory=True)
        except (OSError, HTTPException):
            return
        try:
            for entry in sorted(os.scandir(fd), key=lambda item: item.name):
                path = posixpath.join(directory, entry.name)
                if len(found) >= limit:
                    return
                if entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    visit(path)
                elif entry.is_file(follow_symlinks=False):
                    found.append({'path': path, 'size_bytes': entry.stat(follow_symlinks=False).st_size})
        finally:
            os.close(fd)

    visit('')
    return found


HASHED = re.compile(r'^(.+)-[0-9a-f]{8}$')


def normalize_hashed_directories(data_dir):
    """Rename `<n>-<8 hex>` skill directories in every workspace to `<n>` when the SKILL.md name normalizes to `<n>`
    and `<n>` is free. Symlinks are never followed; conflicting or unreadable directories are left alone. Returns the
    number of renames."""
    data_dir = Path(data_dir)
    renamed = 0
    workspaces = data_dir / 'workspaces'
    candidates = []
    for group in (workspaces, workspaces / 'channels'):
        try:
            candidates += [entry.path for entry in os.scandir(group) if entry.is_dir(follow_symlinks=False)]
        except OSError:
            continue
    for workspace in candidates:
        directory = Path(workspace) / WORKSPACE_REL
        try:
            ok = True
            for parent in (Path(workspace) / '.agent-platform', directory):
                ok = ok and stat.S_ISDIR(os.lstat(parent).st_mode)
            if not ok:
                continue
            names = sorted(entry.name for entry in os.scandir(directory) if entry.is_dir(follow_symlinks=False))
        except OSError:
            continue
        for dirname in names:
            match = HASHED.match(dirname)
            if not match or os.path.lexists(directory / match[1]):
                continue
            read = _read_skill_md(directory, dirname)
            if read is None or normalize_name(parse_skill(read[0], dirname, False)['name']) != match[1]:
                continue
            try:
                os.rename(directory / dirname, directory / match[1])
                renamed += 1
            except OSError:
                log.warning('Could not rename skill directory %s', directory / dirname)
    return renamed


# -- archive reading ------------------------------------------------------------------------------

@dataclass
class Entry:
    parts: tuple
    kind: str                      # file | dir | link | special
    size: int
    executable: bool
    handle: object


def _safe_parts(name):
    if '\x00' in name or '\\' in name:
        raise SkillError(400, 'skill_invalid', 'Archive contains an unsafe path')
    if name.startswith('/'):
        raise SkillError(400, 'skill_invalid', 'Archive contains an absolute path')
    parts = tuple(part for part in name.split('/') if part not in ('', '.'))
    if '..' in parts:
        raise SkillError(400, 'skill_invalid', 'Archive path escapes the skill directory')
    return parts


def _archive(data):
    """`(entries, read)` for a zip/.skill or gzip tar archive; `read(entry)` yields a binary stream."""
    try:
        if data[:4] == b'PK\x03\x04':
            archive = zipfile.ZipFile(io.BytesIO(data))
            infos = archive.infolist()
            if len(infos) > 2 * MAX_FILES:
                raise SkillError(413, 'skill_invalid', f'The package has more than {MAX_FILES} files')
            entries = []
            for info in infos:
                if info.flag_bits & 1:
                    raise SkillError(400, 'skill_invalid', 'Encrypted archives are not supported')
                mode = info.external_attr >> 16
                kind_bits = stat.S_IFMT(mode)
                # Permission bits alone (no file-type field) mean a regular file; only explicit link/device types are refused.
                kind = ('dir' if info.is_dir() else 'link' if kind_bits == stat.S_IFLNK else
                        'file' if kind_bits in (0, stat.S_IFREG) else 'special')
                entries.append(Entry(_safe_parts(info.filename), kind, info.file_size, bool(mode & 0o111), info))
            return entries, archive.open
        if data[:2] == b'\x1f\x8b':
            archive = tarfile.open(fileobj=io.BytesIO(data), mode='r:gz')
            entries = []
            total = 0
            # Iterate lazily: limits apply to each header before its data is skipped or read.
            for member in archive:
                if len(entries) >= 2 * MAX_FILES:
                    raise SkillError(413, 'skill_invalid', f'The package has more than {MAX_FILES} files')
                if member.size > MAX_UNPACKED or (total := total + member.size) > MAX_UNPACKED:
                    raise SkillError(413, 'skill_invalid', 'The unpacked skill is too large')
                kind = ('dir' if member.isdir() else 'file' if member.isreg() else
                        'link' if member.issym() or member.islnk() else 'special')
                entries.append(Entry(_safe_parts(member.name), kind, member.size, bool(member.mode & 0o111), member))
            return entries, archive.extractfile
    except (zipfile.BadZipFile, tarfile.TarError, EOFError, OSError) as exc:
        raise SkillError(400, 'skill_invalid', 'The archive is damaged or unreadable') from exc
    raise SkillError(400, 'skill_invalid', 'Unsupported package: expected a zip, .skill, .tar.gz or SKILL.md')


def _select(entries, subpath, read):
    """The one skill root (tuple of path parts) inside the archive, or a typed error."""
    roots = sorted({entry.parts[:-1] for entry in entries if entry.kind == 'file' and entry.parts and entry.parts[-1] == 'SKILL.md'},
                   key=lambda parts: (len(parts), parts))
    tops = {entry.parts[0] for entry in entries if entry.parts}
    wrapper = 1 if len(tops) == 1 and all(len(entry.parts) > 1 or entry.kind == 'dir' for entry in entries) else 0
    if subpath:
        wanted = _safe_parts(subpath)
        matches = [root for root in roots if len(root) >= len(wanted) and root[len(root) - len(wanted):] == wanted
                   and len(root) - len(wanted) <= wrapper]
        if not matches:
            raise SkillError(400, 'skill_invalid', f'No SKILL.md found under "{subpath}"')
        return matches[0]
    if not roots:
        raise SkillError(400, 'skill_invalid', 'The package contains no SKILL.md')
    if len(roots) == 1 or (len(roots[0]) <= wrapper and len(roots[1]) > len(roots[0])):
        return roots[0]
    candidates = []
    by_parts = {entry.parts: entry for entry in entries if entry.kind == 'file'}
    for root in roots[:MAX_CANDIDATES]:
        name = root[-1] if root else 'skill'
        stream = read(by_parts[root + ('SKILL.md',)].handle)
        if stream is not None:
            try:
                name = parse_skill(stream.read(MAX_SKILL_MD).decode('utf-8'), name, False)['name'] or name
            except UnicodeError:
                pass
        candidates.append({'name': name, 'subpath': '/'.join(root[wrapper:])})
    raise SkillError(409, 'skill_candidates', 'The package contains several skills; choose one with a sub-path',
                     candidates=candidates)


def _extract(data, subpath, destination):
    entries, read = _archive(data)
    root = _select(entries, subpath, read)
    selected = [entry for entry in entries if entry.parts[:len(root)] == root and len(entry.parts) > len(root)]
    files = [entry for entry in selected if entry.kind != 'dir']
    if any(entry.kind in ('link', 'special') for entry in files):
        raise SkillError(400, 'skill_invalid', 'Symbolic links, hard links and device files are not allowed')
    if len(files) > MAX_FILES:
        raise SkillError(413, 'skill_invalid', f'The skill has more than {MAX_FILES} files')
    if sum(entry.size for entry in files) > MAX_UNPACKED:
        raise SkillError(413, 'skill_invalid', 'The unpacked skill is too large')
    seen = set()
    total = 0
    for entry in selected:
        relative = entry.parts[len(root):]
        if not relative:
            continue
        if relative in seen:
            raise SkillError(400, 'skill_invalid', 'Archive contains duplicate paths')
        seen.add(relative)
        target = destination.joinpath(*relative)
        if entry.kind == 'dir':
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        limit = MAX_SKILL_MD if relative == ('SKILL.md',) else None
        stream = read(entry.handle)
        with open(target, 'xb') as out:
            while chunk := stream.read(65536):
                total += len(chunk)
                if total > MAX_UNPACKED:
                    raise SkillError(413, 'skill_invalid', 'The unpacked skill is too large')
                if limit is not None and out.tell() + len(chunk) > limit:
                    raise SkillError(413, 'skill_invalid', 'SKILL.md exceeds 256 KB')
                out.write(chunk)
        os.chmod(target, 0o755 if entry.executable else 0o644)
    return root


def _github(url):
    """`(codeload URL, sub-path)` for a GitHub repo, tree or blob URL, else None."""
    parts = urlsplit(url)
    segments = [segment for segment in parts.path.split('/') if segment]
    if parts.hostname not in ('github.com', 'www.github.com') or len(segments) < 2:
        return None
    if len(segments) > 2 and segments[2] not in ('tree', 'blob'):
        return None
    owner, repo = segments[0], segments[1].removesuffix('.git')
    ref, rest = 'HEAD', []
    if len(segments) >= 4:
        ref, rest = segments[3], segments[4:]
        if segments[2] == 'blob' and rest and rest[-1].lower() == 'skill.md':
            rest = rest[:-1]
    elif len(segments) == 3:
        return None
    if not re.fullmatch(r'[A-Za-z0-9._-]+', owner) or not re.fullmatch(r'[A-Za-z0-9._-]+', repo) or not re.fullmatch(r'[\w./+-]+', ref):
        raise SkillError(400, 'skill_invalid', 'Unrecognized GitHub URL')
    return f'https://codeload.github.com/{owner}/{repo}/tar.gz/{ref}', '/'.join(rest)


# -- tree writing ---------------------------------------------------------------------------------

def _renameat2(parent_fd, old, new, flags):
    """RENAME_NOREPLACE / RENAME_EXCHANGE inside one pinned directory; False where the kernel or libc lacks it."""
    try:
        function = ctypes.CDLL(None, use_errno=True).renameat2
    except (AttributeError, OSError):
        return False
    if function(parent_fd, os.fsencode(old), parent_fd, os.fsencode(new), ctypes.c_uint(flags)) == 0:
        return True
    code = ctypes.get_errno()
    if code in (errno.ENOSYS, errno.EINVAL):
        return False
    raise OSError(code, os.strerror(code))


def _write_tree(parent_fd, name, source):
    """Copy `source` (a private directory) to `<parent>/<name>` with no link following, modes 0755/0644."""
    def copy(directory_fd, path):
        for entry in sorted(os.scandir(path), key=lambda item: item.name):
            if entry.is_dir(follow_symlinks=False):
                os.mkdir(entry.name, 0o700, dir_fd=directory_fd)
                child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_fd)
                try:
                    copy(child, entry.path)
                    os.fchmod(child, 0o755)
                finally:
                    os.close(child)
            elif entry.is_file(follow_symlinks=False):
                executable = entry.stat(follow_symlinks=False).st_mode & 0o111
                out = os.open(entry.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory_fd)
                with os.fdopen(out, 'wb') as stream, open(entry.path, 'rb') as origin:
                    shutil.copyfileobj(origin, stream)
                    os.fchmod(stream.fileno(), 0o755 if executable else 0o644)
            else:
                raise SkillError(400, 'skill_invalid', 'Unsupported file type in the skill')

    os.mkdir(name, 0o700, dir_fd=parent_fd)
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        copy(fd, source)
        os.fchmod(fd, 0o755)
    finally:
        os.close(fd)


def _discard(parent_fd, name):
    """Remove `<parent>/<name>` without following links (rmtree on a pinned descriptor path)."""
    shutil.rmtree(f'/proc/self/fd/{parent_fd}/{name}', ignore_errors=True)


def _exists(parent_fd, name):
    try:
        os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return False
    return True


def install_directory(parent_fd, name, source, replace, retire=None):
    """Atomically publish `source` as `<parent>/<name>`; `replace` swaps an existing directory in one step."""
    staging = f'.install-{secrets.token_hex(6)}'
    try:
        _write_tree(parent_fd, staging, source)
        if _exists(parent_fd, name):
            if not replace:
                raise SkillError(409, 'skill_exists', f'Skill "{name}" is already installed', name=name)
            if not _renameat2(parent_fd, staging, name, _RENAME_EXCHANGE):
                old = f'.old-{secrets.token_hex(6)}'
                os.rename(name, old, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
                os.rename(staging, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
                staging = old
        else:
            try:
                if not _renameat2(parent_fd, staging, name, _RENAME_NOREPLACE):
                    os.rename(staging, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
                staging = None
            except FileExistsError:
                raise SkillError(409, 'skill_exists', f'Skill "{name}" is already installed', name=name) from None
    finally:
        if staging is not None:
            _discard(parent_fd, staging)
    if retire and retire != name and _exists(parent_fd, retire):
        _discard(parent_fd, retire)


def _stage_content(spec, destination):
    name, description, body = spec.get('name'), spec.get('description'), spec.get('body')
    files = spec.get('files') or {}
    if not isinstance(name, str) or not isinstance(description, str) or not isinstance(body, str) or not isinstance(files, dict):
        raise SkillError(400, 'skill_invalid', 'content needs name, description and body strings and an optional files map')
    frontmatter = yaml.safe_dump({'name': name, 'description': description}, allow_unicode=True, sort_keys=False, width=10**6)
    text = f'---\n{frontmatter}---\n\n{body.rstrip()}\n'
    if len(text.encode()) > MAX_SKILL_MD:
        raise SkillError(413, 'skill_invalid', 'SKILL.md exceeds 256 KB')
    (destination / 'SKILL.md').write_text(text, encoding='utf-8')
    if len(files) > MAX_FILES:
        raise SkillError(413, 'skill_invalid', f'The skill has more than {MAX_FILES} files')
    total = 0
    for relative, content in files.items():
        parts = _safe_parts(relative) if isinstance(relative, str) else ()
        if not parts or parts == ('SKILL.md',) or not isinstance(content, str):
            raise SkillError(400, 'skill_invalid', 'files must map relative paths (not SKILL.md) to text')
        total += len(content.encode())
        if total > MAX_UNPACKED:
            raise SkillError(413, 'skill_invalid', 'The unpacked skill is too large')
        target = destination.joinpath(*parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding='utf-8')


def _promote(destination, inner):
    """Make `inner` (below `destination`) the staged package root."""
    staged = destination.with_name(destination.name + '-sub')
    inner.rename(staged)
    shutil.rmtree(destination)
    staged.rename(destination)


def _stage_archive_tree(destination, subpath):
    """Select the skill inside a staged directory: the sub-path, the root, or the only nested one."""
    if subpath:
        inner = destination.joinpath(*_safe_parts(subpath))
        if not (inner / 'SKILL.md').is_file():
            raise SkillError(400, 'skill_invalid', f'No SKILL.md found under "{subpath}"')
        if inner != destination:
            _promote(destination, inner)
        return
    if (destination / 'SKILL.md').is_file():
        return
    roots = sorted(path.parent.relative_to(destination).parts for path in destination.rglob('SKILL.md'))
    if not roots:
        raise SkillError(400, 'skill_invalid', 'The package contains no SKILL.md')
    if len(roots) > 1:
        candidates = []
        for root in roots[:MAX_CANDIDATES]:
            text = (destination.joinpath(*root) / 'SKILL.md').read_text(encoding='utf-8', errors='replace')
            candidates.append({'name': parse_skill(text, root[-1], False)['name'] or root[-1], 'subpath': '/'.join(root)})
        raise SkillError(409, 'skill_candidates', 'The package contains several skills; choose one with a sub-path',
                         candidates=candidates)
    _promote(destination, destination.joinpath(*roots[0]))


def _copy_workspace_directory(workspace, value, destination):
    """Copy a workspace directory below `destination` through pinned descriptors; links are refused."""
    count = total = 0

    def copy(relative):
        nonlocal count, total
        directory = open_workspace(workspace, posixpath.join(value, relative), directory=True)
        try:
            entries = sorted(os.scandir(directory), key=lambda item: item.name)
        finally:
            os.close(directory)
        for entry in entries:
            path = posixpath.join(relative, entry.name)
            if entry.is_dir(follow_symlinks=False):
                (destination / path).mkdir()
                copy(path)
            elif entry.is_file(follow_symlinks=False):
                count += 1
                if count > MAX_FILES:
                    raise SkillError(413, 'skill_invalid', f'The skill has more than {MAX_FILES} files')
                with os.fdopen(open_workspace(workspace, posixpath.join(value, path)), 'rb') as origin, open(destination / path, 'xb') as out:
                    executable = os.fstat(origin.fileno()).st_mode & 0o111
                    while chunk := origin.read(65536):
                        total += len(chunk)
                        if total > MAX_UNPACKED:
                            raise SkillError(413, 'skill_invalid', 'The unpacked skill is too large')
                        out.write(chunk)
                os.chmod(destination / path, 0o755 if executable else 0o644)
            else:
                raise SkillError(400, 'skill_invalid', 'Symbolic links, hard links and device files are not allowed')

    copy('')


def _stage_workspace_path(workspace, value, subpath, destination):
    """Stage a workspace directory, or unpack a workspace zip/.skill/.tar.gz, through pinned descriptors."""
    value = value.strip()
    if value == '/workspace' or value.startswith('/workspace/'):
        value = value[len('/workspace'):]
    elif value.startswith('/'):
        raise SkillError(400, 'skill_invalid', 'path must be inside /workspace')
    parts = [part for part in value.split('/') if part not in ('', '.')]
    if '\x00' in value or '..' in parts or not parts:
        raise SkillError(400, 'skill_invalid', 'path must name a directory, zip or .skill file inside /workspace')
    value = '/'.join(parts)
    try:
        fd = open_workspace(workspace, value, directory=True)
    except FileNotFoundError:
        raise SkillError(404, 'skill_not_found', f'No such path in the workspace: {value}') from None
    except (OSError, HTTPException):
        fd = None
    if fd is not None:
        os.close(fd)
        _copy_workspace_directory(workspace, value, destination)
        _stage_archive_tree(destination, subpath)
        return
    try:
        file_fd = open_workspace(workspace, value)
    except FileNotFoundError:
        raise SkillError(404, 'skill_not_found', f'No such path in the workspace: {value}') from None
    except (OSError, HTTPException):
        raise SkillError(400, 'skill_invalid', 'path must be a directory, zip or .skill file inside the workspace') from None
    with os.fdopen(file_fd, 'rb') as stream:
        data = stream.read(MAX_DOWNLOAD + 1)
    if len(data) > MAX_DOWNLOAD:
        raise SkillError(413, 'skill_invalid', 'The package exceeds 50 MB')
    _extract(data, subpath, destination)


# -- the service ----------------------------------------------------------------------------------

class Skills:
    def __init__(self, platform):
        self.p = platform
        self.locks = {}

    # -- storage locations ------------------------------------------------------------------------

    @property
    def builtin_root(self):
        return Path(self.p.settings.builtin_skills_dir)

    @property
    def org_root(self):
        return self.p.settings.data_dir / 'skills' / 'org'

    def workspace_for(self, user, scope):
        """`(kind, workspace, channel_id)` for the API scope names `private`, `chat` and `channel-<id>`."""
        data = self.p.settings.data_dir / 'workspaces'
        if scope == 'private':
            return 'private', data / f"user-{user['id']}", None
        if scope == 'chat':
            return 'chat', None, None
        if scope.startswith('channel-') and scope[8:].isdigit():
            return 'channel', data / 'channels' / f'channel-{scope[8:]}', int(scope[8:])
        raise SkillError(400, 'skill_invalid', 'Unknown skill scope')

    def scope_of(self, info):
        if info['kind'] == 'chat':
            return 'chat', None, None
        if info['channel_id'] is not None:
            return 'channel', info['workspace'], info['channel_id']
        return 'private', info['workspace'], None

    # -- database ---------------------------------------------------------------------------------

    def row(self, tier, owner, name):
        with self.p.db.connect() as conn:
            return conn.execute('SELECT * FROM skills WHERE tier=? AND COALESCE(owner_id,0)=? AND name=?',
                                (tier, owner or 0, name)).fetchone()

    def org_rows(self):
        with self.p.db.connect() as conn:
            return conn.execute("SELECT * FROM skills WHERE tier='org' ORDER BY name").fetchall()

    def disabled_builtins(self):
        with self.p.db.connect() as conn:
            row = conn.execute('SELECT value FROM settings WHERE key=?', (DISABLED_BUILTIN_KEY,)).fetchone()
        return set(json.loads(row[0])) if row else set()

    def preferences(self, user):
        with self.p.db.connect() as conn:
            return {row[0]: bool(row[1]) for row in conn.execute('SELECT skill_key,enabled FROM skill_preferences WHERE user_id=?', (user['id'],))}

    def _record(self, tier, owner, name, source, installed_by, groups_json=None):
        now = int(time.time())
        with self.p.db.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            existing = conn.execute('SELECT id FROM skills WHERE tier=? AND COALESCE(owner_id,0)=? AND name=?', (tier, owner or 0, name)).fetchone()
            if existing:
                conn.execute('UPDATE skills SET source_json=?,updated_at=?,installed_by=?,groups_json=COALESCE(?,groups_json) WHERE id=?',
                             (json.dumps(source), now, installed_by, groups_json, existing[0]))
            else:
                conn.execute('INSERT INTO skills(tier,owner_id,name,source_json,groups_json,enabled,installed_by,installed_at,updated_at) VALUES (?,?,?,?,?,1,?,?,?)',
                             (tier, owner, name, json.dumps(source), groups_json, installed_by, now, now))

    def _forget(self, tier, owner, name):
        with self.p.db.connect() as conn:
            conn.execute('DELETE FROM skills WHERE tier=? AND COALESCE(owner_id,0)=? AND name=?', (tier, owner or 0, name))

    # -- discovery --------------------------------------------------------------------------------

    def _scan(self, root, base, tier, location, key, dirs=None, source=None):
        found, names = [], set()
        candidates = _list_dir(root, base) if dirs is None else dirs
        # A directory named exactly after its skill wins over a hash-suffixed duplicate.
        parsed = []
        for dirname in candidates:
            if dirname.startswith('.'):
                continue
            read = _read_skill_md(root, posixpath.join(base, dirname))
            if read is None:
                continue
            meta = parse_skill(read[0], dirname, False)
            if meta['description'] is None or not meta['name']:
                log.warning('Skill %s/%s is excluded: %s', tier, dirname, '; '.join(meta['warnings']))
                continue
            parsed.append((meta['name'] != dirname, dirname, meta, read[1]))
        for _, dirname, meta, mtime in sorted(parsed, key=lambda item: item[:2]):
            if meta['name'] in names:
                log.warning('Skill %s/%s duplicates the name %s and is ignored', tier, dirname, meta['name'])
                continue
            names.add(meta['name'])
            skill = Skill(tier=tier, name=meta['name'], dirname=dirname, description=meta['description'], root=root,
                          rel=posixpath.join(base, dirname), location=f'{location}/{dirname}/SKILL.md',
                          key=key(meta['name']), version=meta['version'], hidden=meta['hidden'],
                          warnings=meta['warnings'], updated_at=_iso(mtime), frontmatter=meta['frontmatter'])
            skill.source = source(skill) if source else None
            found.append(skill)
        return found

    def builtin_skills(self):
        return self._scan(self.builtin_root.resolve(), '', 'builtin', BUILTIN_LOCATION, lambda name: f'builtin:{name}')

    def org_skills(self):
        """Every organization skill with its row: `[(Skill, row)]` (rows without a readable directory are skipped)."""
        rows = {row['name']: row for row in self.org_rows()}
        if not rows:
            return []
        root = self.org_root
        root.mkdir(parents=True, exist_ok=True)
        skills = self._scan(root.resolve(), '', 'org', ORG_LOCATION, lambda name: f'org:{name}', dirs=sorted(rows))
        return [(skill, rows[skill.dirname]) for skill in skills]

    def workspace_skills(self, workspace, tier, owner):
        def source(skill):
            row = self.row(tier, owner, skill.name)
            return {key: value for key, value in json.loads(row['source_json']).items() if key in ('kind', 'url')} if row else {'kind': 'workspace'}

        def key(name):
            return f'personal:{name}' if tier == 'personal' else f'channel:{owner}:{name}'
        return self._scan(Path(workspace), WORKSPACE_REL, tier, WORKSPACE_LOCATION, key, source=source)

    def visible(self, user, kind, workspace=None, channel_id=None, preferences=True):
        """Skills the scope may use, by precedence (personal/channel, org, built-in); disabled and hidden ones included."""
        granted = permissions(self.p.db, user)
        chosen = {}

        def add(skills):
            for skill in skills:
                chosen.setdefault(skill.name, skill)
        if kind == 'private' and INSTALL in granted:
            add(self.workspace_skills(workspace, 'personal', user['id']))
        elif kind == 'channel':
            add(self.workspace_skills(workspace, 'channel', channel_id))
        add([skill for skill, row in self.org_skills() if row['enabled'] and self._assigned(row, user)])
        disabled = self.disabled_builtins()
        add([skill for skill in self.builtin_skills() if skill.name not in disabled])
        if kind != 'channel' and preferences:
            prefs = self.preferences(user)
            for skill in chosen.values():
                skill.enabled = prefs.get(skill.key, True)
        return sorted(chosen.values(), key=lambda skill: skill.name)

    @staticmethod
    def _assigned(row, user):
        assigned = json.loads(row['groups_json'] or '["*"]')
        return '*' in assigned or user['permission_group'] in assigned

    def catalog(self, user, info):
        """`[{name, description, location}]` for Runtime: the model-visible skills of the run's scope."""
        kind, workspace, channel = self.scope_of(info)
        return [{'name': skill.name, 'description': skill.description, 'location': skill.location}
                for skill in self.visible(user, kind, workspace, channel) if skill.enabled and not skill.hidden]

    def invoke(self, user, info, text):
        """Prefix an explicit `/<skill>` invocation (hidden skills included); other text is returned unchanged."""
        match = INVOKE.match(text)
        if not match:
            return text
        kind, workspace, channel = self.scope_of(info)
        name = match[1].lower()
        skill = next((item for item in self.visible(user, kind, workspace, channel) if item.name == name and item.enabled), None)
        if skill is None:
            return text
        sentence = (f'[The user invoked the "{skill.name}" skill. Read {skill.location} first and follow it; '
                    f'resolve its relative paths against {skill.directory}.]')
        rest = text[match.end():].strip()
        return sentence + ('\n' + rest if rest else '')

    # -- views ------------------------------------------------------------------------------------

    def view(self, skill, user=None):
        manageable = skill.tier == 'personal' and user is not None and INSTALL in permissions(self.p.db, user)
        return {'key': skill.key, 'name': skill.name, 'description': skill.description, 'tier': skill.tier,
                'version': skill.version, 'source': skill.source if skill.tier in ('personal', 'channel') else None,
                'enabled': skill.enabled, 'user_disableable': skill.tier != 'channel', 'manageable': manageable,
                'updated_at': skill.updated_at, 'warnings': skill.warnings}

    def view_for(self, skill, user):
        """A SkillView with the user's own on/off preference applied (the stored preference is never changed)."""
        if skill.tier != 'channel':
            skill.enabled = self.preferences(user).get(skill.key, True)
        return self.view(skill, user)

    def resolve_key(self, user, key):
        """The skill a key names, only if this user may see it: `(Skill, row or None)`."""
        granted = permissions(self.p.db, user)
        administrator = 'system_settings' in granted
        parts = key.split(':')
        missing = SkillError(404, 'skill_not_found', 'Skill not found')
        if parts[0] == 'builtin' and len(parts) == 2:
            skill = next((item for item in self.builtin_skills() if item.name == parts[1]), None)
            if skill is None or (skill.name in self.disabled_builtins() and not administrator):
                raise missing
            return skill, None
        if parts[0] == 'org' and len(parts) == 2:
            for skill, row in self.org_skills():
                if skill.name == parts[1] and (administrator or (row['enabled'] and self._assigned(row, user))):
                    return skill, row
            raise missing
        if parts[0] == 'personal' and len(parts) == 2 and INSTALL in granted and 'private_agent' in granted:
            _, workspace, _ = self.workspace_for(user, 'private')
            skill = next((item for item in self.workspace_skills(workspace, 'personal', user['id']) if item.name == parts[1]), None)
            if skill:
                return skill, None
        if parts[0] == 'channel' and len(parts) == 3 and parts[1].isdigit() and 'read_workspace' in granted:
            with self.p.db.connect() as conn:
                live = conn.execute('SELECT 1 FROM channels WHERE id=? AND archived=0', (parts[1],)).fetchone()
            if live:
                _, workspace, channel = self.workspace_for(user, 'channel-' + parts[1])
                skill = next((item for item in self.workspace_skills(workspace, 'channel', channel) if item.name == parts[2]), None)
                if skill:
                    return skill, None
        raise missing

    def detail(self, skill):
        read = _read_skill_md(skill.root, skill.rel)
        return {'content': read[0] if read else '', 'files': list_files(skill.root, skill.rel)}

    # -- installing -------------------------------------------------------------------------------

    def require_install(self, user):
        if INSTALL not in permissions(self.p.db, user):
            raise SkillError(403, 'install_extensions_required', 'Your permission group cannot install skills')

    async def fetch_package(self, url, subpath):
        """`(archive or SKILL.md bytes, sub-path)` for a URL, through the SSRF-guarded download."""
        github = _github(url)
        target, derived = github if github else (url, '')
        try:
            _, data, _, _ = await download(target, MAX_DOWNLOAD, 'The package exceeds 50 MB', deadline=180)
        except httpx.HTTPStatusError as exc:
            raise SkillError(502, 'skill_fetch_failed', f'The download failed with HTTP {exc.response.status_code}') from exc
        except httpx.HTTPError as exc:
            raise SkillError(502, 'skill_fetch_failed', 'The download failed') from exc
        except TimeoutError as exc:
            raise SkillError(504, 'skill_fetch_failed', 'The download timed out') from exc
        except HTTPException as exc:
            raise SkillError(exc.status_code, 'skill_fetch_failed', exc.detail) from exc
        return data, (subpath or derived or None)

    def stage(self, spec, workspace, destination):
        """Unpack one source into `destination`; returns the recorded source."""
        if 'content' in spec:
            _stage_content(spec['content'], destination)
            return {'kind': 'ai'}
        if 'path' in spec:
            _stage_workspace_path(workspace, spec['path'], spec.get('subpath'), destination)
            return {'kind': 'workspace', 'path': spec['path'], **({'subpath': spec['subpath']} if spec.get('subpath') else {})}
        data = spec['data']
        if data[:4] == b'PK\x03\x04' or data[:2] == b'\x1f\x8b':
            _extract(data, spec.get('subpath'), destination)
        elif spec['kind'] == 'url' and not data.startswith(b'\x00'):
            if len(data) > MAX_SKILL_MD:
                raise SkillError(413, 'skill_invalid', 'SKILL.md exceeds 256 KB')
            try:
                (destination / 'SKILL.md').write_text(data.decode('utf-8'), encoding='utf-8')
            except UnicodeError as exc:
                raise SkillError(400, 'skill_invalid', 'The downloaded file is not a skill package') from exc
        else:
            raise SkillError(400, 'skill_invalid', 'Unsupported package: expected a zip, .skill or .tar.gz file')
        record = {'kind': spec['kind']}
        if spec['kind'] == 'url':
            record['url'] = spec['url']
        if spec.get('subpath'):
            record['subpath'] = spec['subpath']
        return record

    def _lock(self, tier, owner):
        return self.locks.setdefault((tier, owner), asyncio.Lock())

    def _parent(self, tier, workspace):
        """An open directory descriptor for the tier's skills directory, created as needed."""
        if tier == 'org':
            for directory in (self.org_root.parent, self.org_root):
                directory.mkdir(parents=True, exist_ok=True)
                if directory.stat().st_mode & 0o755 != 0o755:
                    directory.chmod(0o755)  # Manager normally creates these; fix only what is too restrictive
            return os.open(self.org_root.resolve(), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        ensure_workspace(self.p.settings.data_dir, Path(workspace))
        ensure_workspace(Path(workspace), Path(workspace) / WORKSPACE_REL)
        return open_workspace(workspace, WORKSPACE_REL, directory=True)

    async def install(self, user, tier, owner, workspace, spec, replace=False, groups_json=None, expect_name=None):
        """Install one skill into a tier; returns the installed Skill. `spec` is one of url/path/content/upload."""
        if 'url' in spec:
            data, subpath = await self.fetch_package(spec['url'], spec.get('subpath'))
            spec = {'kind': 'url', 'url': spec['url'], 'data': data, 'subpath': subpath}
        elif 'upload' in spec:
            spec = {'kind': 'upload', 'data': spec['upload'], 'subpath': spec.get('subpath')}
        async with self._lock(tier, owner):
            with tempfile.TemporaryDirectory(prefix='skill-') as scratch:
                package = Path(scratch) / 'package'
                package.mkdir()
                source = await asyncio.to_thread(self.stage, spec, workspace, package)
                read = _read_skill_md(Path(scratch), 'package')
                if read is None:
                    raise SkillError(400, 'skill_invalid', 'SKILL.md is missing, not UTF-8 or larger than 256 KB')
                meta = parse_skill(read[0], '', True)
                name = meta['name']
                if expect_name is not None and name != expect_name:
                    raise SkillError(409, 'skill_update_renamed',
                                     f'The source now names this skill "{name}", not "{expect_name}"; nothing was changed',
                                     name=expect_name, new_name=name)
                existing = self._find(tier, owner, workspace, name)
                if existing and not replace:
                    raise SkillError(409, 'skill_exists', f'Skill "{name}" is already installed', name=name)
                parent = self._parent(tier, workspace)
                try:
                    await asyncio.to_thread(install_directory, parent, name, package, replace,
                                            existing.dirname if existing else None)
                finally:
                    os.close(parent)
        self._record(tier, owner, name, source, user['id'], groups_json)
        installed = self._find(tier, owner, workspace, name)
        if installed is None:
            raise SkillError(500, 'skill_invalid', 'The installed skill could not be read back')
        return installed

    def _find(self, tier, owner, workspace, name):
        if tier == 'org':
            return next((skill for skill, _ in self.org_skills() if skill.name == name), None)
        return next((skill for skill in self.workspace_skills(workspace, tier, owner) if skill.name == name), None)

    async def update(self, user, tier, owner, workspace, name):
        row = self.row(tier, owner, name)
        source = json.loads(row['source_json']) if row else {}
        if not self._find(tier, owner, workspace, name):
            raise SkillError(404, 'skill_not_found', f'Skill "{name}" not found')
        if source.get('kind') != 'url' or not source.get('url'):
            raise SkillError(400, 'skill_not_updatable', f'Skill "{name}" was not installed from a URL, so it cannot be updated')
        return await self.install(user, tier, owner, workspace, {'url': source['url'], 'subpath': source.get('subpath')},
                                  replace=True, expect_name=name)

    async def remove(self, tier, owner, workspace, name):
        skill = self._find(tier, owner, workspace, name)
        if skill is None:
            raise SkillError(404, 'skill_not_found', f'Skill "{name}" not found')
        async with self._lock(tier, owner):
            parent = self._parent(tier, workspace)
            try:
                trash = f'.trash-{secrets.token_hex(6)}'
                os.rename(skill.dirname, trash, src_dir_fd=parent, dst_dir_fd=parent)
                _discard(parent, trash)
            finally:
                os.close(parent)
        self._forget(tier, owner, skill.name)

    # -- AI tool ----------------------------------------------------------------------------------

    async def gateway(self, user, info, action, args):
        """The `skill` tool for personal and channel root runs."""
        kind, workspace, channel = self.scope_of(info)
        tier = 'channel' if kind == 'channel' else 'personal'
        owner = channel if kind == 'channel' else user['id']
        try:
            if action == 'list':
                skills = self.visible(user, kind, workspace, channel)
                lines = [f'{skill.name} [{skill.tier}] {skill.description}' for skill in skills]
                return _tool('\n'.join(lines) or 'No skills are available.', {'skills': [self._tool_view(skill) for skill in skills]})
            if action == 'info':
                skill = self._named(user, kind, workspace, channel, args)
                detail = self.detail(skill)
                data = {**self._tool_view(skill), 'frontmatter': skill.frontmatter, 'files': detail['files']}
                return _tool(f'{skill.name} [{skill.tier}] at {skill.location}\n{skill.description}\n' +
                             '\n'.join(item['path'] for item in detail['files']), data)
            if action in ('install', 'update', 'remove'):
                self.require_install(user)
            if action == 'install':
                given = [key for key in ('url', 'path', 'content') if args.get(key) not in (None, '')]
                if len(given) != 1:
                    raise SkillError(400, 'skill_invalid', 'Give exactly one of url, path or content')
                spec = {given[0]: args[given[0]]}
                if given[0] != 'content' and args.get('subpath'):
                    spec['subpath'] = args['subpath']
                if given[0] in ('url', 'path') and not isinstance(args[given[0]], str):
                    raise SkillError(400, 'skill_invalid', f'{given[0]} must be a string')
                skill = await self.install(user, tier, owner, workspace, spec, replace=args.get('replace') is True)
                return _tool(f'Installed skill "{skill.name}" at {skill.directory}. It is usable from the next message.',
                             self._tool_view(skill))
            name = args.get('name')
            if action in ('update', 'remove'):
                if not isinstance(name, str) or not name.strip():
                    raise SkillError(400, 'skill_invalid', 'name is required')
                name = normalize_name(name)
            if action == 'update':
                skill = await self.update(user, tier, owner, workspace, name)
                return _tool(f'Updated skill "{skill.name}" at {skill.directory}. The new version is usable from the next message.',
                             self._tool_view(skill))
            if action == 'remove':
                await self.remove(tier, owner, workspace, name)
                return _tool(f'Removed skill "{name}".', {'name': name})
            raise SkillError(400, 'skill_invalid', 'Unsupported skills action')
        except SkillError as exc:
            return {'content': exc.detail, 'data': {'error': exc.code, **exc.payload}, 'is_error': True}
        except HTTPException as exc:
            return {'content': str(exc.detail), 'data': {'error': 'skill_failed'}, 'is_error': True}

    def _named(self, user, kind, workspace, channel, args):
        name = args.get('name')
        if not isinstance(name, str) or not name.strip():
            raise SkillError(400, 'skill_invalid', 'name is required')
        skill = next((item for item in self.visible(user, kind, workspace, channel) if item.name == normalize_name(name)), None)
        if skill is None:
            raise SkillError(404, 'skill_not_found', f'Skill "{name}" not found')
        return skill

    @staticmethod
    def _tool_view(skill):
        return {'name': skill.name, 'description': skill.description, 'tier': skill.tier, 'source': skill.source,
                'location': skill.location, 'hidden': skill.hidden, 'enabled': skill.enabled}


def _tool(content, data):
    return {'content': content, 'data': data, 'is_error': False}


def skill_guidance(personal):
    """System prompt section on skills and on setup instructions written for other products.

    The MCP bullet applies to the personal AI only: channels have no MCP tool.
    """
    lines = [
        'Skills here use the Agent Skills format (a folder with SKILL.md). Install, update, remove or save skills only with the `skill` tool, '
        "which places them in this platform's skill directory. Users often paste setup instructions written for other products "
        "(Claude Code, Claude Desktop or claude.ai, Codex, Cursor, Gemini CLI, OpenCode). Carry out their intent this platform's way:",
        '- install skills with the `skill` tool instead of copying them into `.claude/skills`, `~/.codex/skills`, `.agents/skills` or similar;',
    ]
    if personal:
        lines.append(
            '- configure MCP servers in `/workspace/.agent-platform/mcp.json` (used through the `mcp` tool) instead of `claude mcp add`, '
            '`codex mcp add`, `.mcp.json`, `~/.claude.json`, `~/.codex/config.toml` or `claude_desktop_config.json`. Its exact format is '
            '`{"mcpServers":{"<id>":{"command":"<executable on PATH or a path inside /workspace>","args":["..."],"env":{"NAME":"value"},"cwd":"/workspace"}}}`: '
            'the id matches `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, at most 32 servers, only `command` (required), `args`, `env` and `cwd` are accepted, '
            'only local stdio servers work (no url, type or headers), and the server process receives only the listed `env` plus PATH, HOME and LANG;')
    lines += [
        '- tell the user in one plain sentence, in their language, that the instructions were for another product and how you adapted them;',
        "- if a step cannot work here (the user's own computer, a desktop app, an app restart), say so plainly.",
    ]
    return '\n'.join(lines)


# -- HTTP API -------------------------------------------------------------------------------------

def _service(request):
    return request.app.state.platform.skills


def _scope_access(request, scope):
    user = current_user(request)
    needed = 'chat' if scope == 'chat' else 'private_agent' if scope == 'private' else 'read_workspace'
    if needed not in permissions(request.app.state.platform.db, user):
        raise HTTPException(403, 'Permission denied')
    service = _service(request)
    kind, workspace, channel = service.workspace_for(user, scope)
    if kind == 'channel':
        with request.app.state.platform.db.connect() as conn:
            if not conn.execute('SELECT 1 FROM channels WHERE id=? AND archived=0', (channel,)).fetchone():
                raise HTTPException(404, 'Channel not found')
    return user, service, kind, workspace, channel


async def list_skills(request):
    user, service, kind, workspace, channel = _scope_access(request, request.query_params.get('scope', 'private'))
    skills = service.visible(user, kind, workspace, channel)
    can = INSTALL in permissions(request.app.state.platform.db, user)
    return JSONResponse({'skills': [service.view(skill, user) for skill in skills], 'can_install': can})


async def read_skill(request):
    user = current_user(request)
    service = _service(request)
    skill, row = service.resolve_key(user, request.path_params['key'])
    return JSONResponse({'skill': service.view_for(skill, user), **service.detail(skill)})


async def _install_request(request, with_groups):
    """Parsed install input: `(spec, replace, groups)` from a multipart upload or a JSON body."""
    if request.headers.get('content-type', '').startswith('multipart/'):
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_DOWNLOAD + 65536:
                raise SkillError(413, 'skill_invalid', 'Upload exceeds 50 MB')
        request._body = bytes(body)
        async with request.form(max_files=1, max_fields=4) as form:
            file = form.get('file')
            if file is None or not hasattr(file, 'read'):
                raise HTTPException(400, 'Multipart file is required')
            data = await file.read(MAX_DOWNLOAD + 1)
            if len(data) > MAX_DOWNLOAD:
                raise SkillError(413, 'skill_invalid', 'Upload exceeds 50 MB')
            spec = {'upload': data, 'subpath': form.get('subpath') or None}
            replace = str(form.get('replace', '')).lower() in ('true', '1')
            raw_groups = form.get('groups')
        try:
            groups_value = json.loads(raw_groups) if raw_groups else None
        except ValueError:
            raise HTTPException(400, 'groups must be a JSON array') from None
    else:
        data = await body_json(request)
        url = data.get('url')
        if not isinstance(url, str) or not url.strip():
            raise HTTPException(400, 'url or a multipart file is required')
        spec = {'url': url.strip(), 'subpath': data.get('subpath') or None}
        replace, groups_value = data.get('replace') is True, data.get('groups')
    if spec.get('subpath') is not None and not isinstance(spec['subpath'], str):
        raise HTTPException(400, 'subpath must be a string')
    return spec, replace, groups_value if with_groups else None


async def install_skill(request):
    user = require_permission(request, 'private_agent')
    service = _service(request)
    service.require_install(user)
    spec, replace, _ = await _install_request(request, False)
    kind, workspace, _ = service.workspace_for(user, 'private')
    skill = await service.install(user, 'personal', user['id'], workspace, spec, replace)
    return JSONResponse({'skill': service.view_for(skill, user)}, status_code=201)


async def update_skill(request):
    user = current_user(request)
    service = _service(request)
    service.require_install(user)
    skill, _ = service.resolve_key(user, request.path_params['key'])
    if skill.tier != 'personal':
        raise SkillError(403, 'skill_not_manageable', 'Only personal skills can be updated here')
    _, workspace, _ = service.workspace_for(user, 'private')
    updated = await service.update(user, 'personal', user['id'], workspace, skill.name)
    return JSONResponse({'skill': service.view_for(updated, user)})


async def delete_skill(request):
    user = current_user(request)
    service = _service(request)
    service.require_install(user)
    skill, _ = service.resolve_key(user, request.path_params['key'])
    if skill.tier != 'personal':
        raise SkillError(403, 'skill_not_manageable', 'Only personal skills can be removed here')
    _, workspace, _ = service.workspace_for(user, 'private')
    await service.remove('personal', user['id'], workspace, skill.name)
    return JSONResponse({'ok': True})


async def set_preference(request):
    user = current_user(request)
    service = _service(request)
    body = await body_json(request)
    if type(body.get('enabled')) is not bool:
        raise HTTPException(400, 'enabled must be a boolean')
    skill, _ = service.resolve_key(user, request.path_params['key'])
    if skill.tier == 'channel':
        raise SkillError(400, 'skill_invalid', 'Channel skills are shared and have no personal preference')
    with request.app.state.platform.db.connect() as conn:
        conn.execute('INSERT INTO skill_preferences(user_id,skill_key,enabled,updated_at) VALUES (?,?,?,?) '
                     'ON CONFLICT(user_id,skill_key) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at',
                     (user['id'], skill.key, int(body['enabled']), int(time.time())))
    skill.enabled = body['enabled']
    return JSONResponse({'skill': service.view(skill, user)})


def _admin_org_view(service, skill, row):
    return {**service.view(skill), 'groups': json.loads(row['groups_json'] or '["*"]'), 'enabled': bool(row['enabled']),
            'source': {key: value for key, value in json.loads(row['source_json']).items() if key in ('kind', 'url')},
            'manageable': True, 'user_disableable': False}


async def admin_list(request):
    require_permission(request, 'system_settings')
    p = request.app.state.platform
    service = p.skills
    disabled = service.disabled_builtins()
    return JSONResponse({
        'org': [_admin_org_view(service, skill, row) for skill, row in service.org_skills()],
        'builtin': [{**service.view(skill), 'org_enabled': skill.name not in disabled, 'user_disableable': False}
                    for skill in service.builtin_skills()],
        'groups': [group['name'] for group in groups(p.db)]})


def _admin_groups(p, value):
    names = {group['name'] for group in groups(p.db)}
    if (not isinstance(value, list) or not value or any(not isinstance(item, str) for item in value) or len(set(value)) != len(value)
            or ('*' in value and len(value) > 1) or any(item != '*' and item not in names for item in value)):
        raise HTTPException(400, 'groups must be ["*"] or existing permission group names')
    return value


async def admin_install(request):
    user = require_permission(request, 'system_settings')
    p = request.app.state.platform
    spec, replace, assigned = await _install_request(request, True)
    assigned = json.dumps(_admin_groups(p, assigned)) if assigned is not None else None
    skill = await p.skills.install(user, 'org', None, None, spec, replace, assigned)
    row = p.skills.row('org', None, skill.name)
    return JSONResponse({'skill': _admin_org_view(p.skills, skill, row)}, status_code=201)


def _set_org(p, name, enabled=None, groups=None):
    with p.db.connect() as conn:
        if enabled is not None:
            conn.execute("UPDATE skills SET enabled=?,updated_at=? WHERE tier='org' AND name=?", (int(enabled), int(time.time()), name))
        if groups is not None:
            conn.execute("UPDATE skills SET groups_json=?,updated_at=? WHERE tier='org' AND name=?", (json.dumps(groups), int(time.time()), name))


def _org(p, name):
    found = next(((skill, row) for skill, row in p.skills.org_skills() if skill.name == name), None)
    if found is None:
        raise SkillError(404, 'skill_not_found', 'Organization skill not found')
    return found


async def admin_patch(request):
    require_permission(request, 'system_settings')
    p = request.app.state.platform
    name = request.path_params['name']
    _org(p, name)
    body = await body_json(request)
    if set(body) - {'enabled', 'groups'}:
        raise HTTPException(400, 'Unknown field')
    if 'enabled' in body and type(body['enabled']) is not bool:
        raise HTTPException(400, 'enabled must be a boolean')
    groups_value = _admin_groups(p, body['groups']) if 'groups' in body else None
    _set_org(p, name, body.get('enabled'), groups_value)
    skill, row = _org(p, name)
    return JSONResponse({'skill': _admin_org_view(p.skills, skill, row)})


async def admin_update(request):
    user = require_permission(request, 'system_settings')
    p = request.app.state.platform
    name = request.path_params['name']
    _org(p, name)
    skill = await p.skills.update(user, 'org', None, None, name)
    return JSONResponse({'skill': _admin_org_view(p.skills, skill, p.skills.row('org', None, skill.name))})


async def admin_delete(request):
    require_permission(request, 'system_settings')
    p = request.app.state.platform
    name = request.path_params['name']
    _org(p, name)
    await p.skills.remove('org', None, None, name)
    return JSONResponse({'ok': True})


async def admin_builtin(request):
    require_permission(request, 'system_settings')
    p = request.app.state.platform
    name = request.path_params['name']
    if not any(skill.name == name for skill in p.skills.builtin_skills()):
        raise SkillError(404, 'skill_not_found', 'Built-in skill not found')
    body = await body_json(request)
    if type(body.get('enabled')) is not bool:
        raise HTTPException(400, 'enabled must be a boolean')
    disabled = p.skills.disabled_builtins() - {name}
    if not body['enabled']:
        disabled.add(name)
    with p.db.connect() as conn:
        conn.execute('INSERT INTO settings(key,value,secret,updated_at) VALUES(?,?,0,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
                     (DISABLED_BUILTIN_KEY, json.dumps(sorted(disabled)), int(time.time())))
    return JSONResponse({'ok': True})


def routes():
    return [Route('/api/skills', list_skills), Route('/api/skills', install_skill, methods=['POST']),
            Route('/api/skills/{key}', read_skill), Route('/api/skills/{key}', delete_skill, methods=['DELETE']),
            Route('/api/skills/{key}/update', update_skill, methods=['POST']),
            Route('/api/skills/{key}/preference', set_preference, methods=['PUT']),
            Route('/api/admin/skills', admin_list), Route('/api/admin/skills', admin_install, methods=['POST']),
            Route('/api/admin/skills/builtin/{name}', admin_builtin, methods=['PUT']),
            Route('/api/admin/skills/{name}', admin_patch, methods=['PATCH']),
            Route('/api/admin/skills/{name}', admin_delete, methods=['DELETE']),
            Route('/api/admin/skills/{name}/update', admin_update, methods=['POST'])]
