"""Artifacts (作品): versioned, content-addressed snapshots of what the AI publishes for the user to look at.

An artifact is identified by `(scope, path)`; each publish with changed content is an immutable version whose
manifest maps relative paths to blobs under `<data_dir>/artifacts/blobs/<sha256>`. Versions are viewed through
short-lived bearer view tokens on an opaque-origin sandboxed route, never through the user's session.
"""
import asyncio
import base64
import codecs
import hashlib
import hmac
import io
import json
import mimetypes
import os
import re
import stat
import tempfile
import threading
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import quote

from starlette.exceptions import HTTPException
from starlette.responses import FileResponse, JSONResponse, RedirectResponse, Response
from starlette.routing import Route

from .auth import current_user
from .db import now
from .files import MAX_FILE, open_workspace

MAX_FILES = 1000
MAX_TOTAL = 50 * 1024 * 1024
MAX_DEPTH = 24
SOURCE_LIMIT = 2 * 1024 * 1024
TOKEN_TTL = 7200
SKIPPED_DIRECTORIES = ('.git', 'node_modules')

KIND_EXTENSIONS = {
    'web': ('.html', '.htm'),
    'markdown': ('.md', '.markdown'),
    'mermaid': ('.mmd', '.mermaid'),
    'svg': ('.svg',),
    'table': ('.csv', '.tsv'),
    'image': ('.png', '.jpg', '.jpeg', '.gif', '.webp'),
    'pdf': ('.pdf',),
    'code': ('.txt', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.xml', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
             '.css', '.scss', '.less', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs',
             '.php', '.sh', '.bash', '.zsh', '.sql', '.lua', '.swift', '.r', '.tex', '.log', '.diff', '.patch', '.vue',
             '.svelte', '.conf', '.dockerfile'),
}
EXTENSION_KIND = {extension: kind for kind, extensions in KIND_EXTENSIONS.items() for extension in extensions}
MIME_OVERRIDES = {
    '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.cjs': 'text/javascript', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml',
    '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
    '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.xml': 'application/xml',
    '.webp': 'image/webp', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.jsx': 'text/javascript',
}
TEXT_MIMES = ('application/json', 'application/xml', 'application/javascript', 'image/svg+xml', 'application/manifest+json')
VIEW_CSP = ("sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads "
            "allow-presentation allow-pointer-lock; frame-ancestors 'self'")
BLOB = re.compile(r'[0-9a-f]{64}')


class ArtifactError(HTTPException):
    """A typed artifact failure, surfaced in the API error body and the tool's error data."""

    def __init__(self, status, code, detail, **payload):
        super().__init__(status, detail)
        self.code = code
        self.payload = payload


def mime_of(relative):
    """Stored MIME type. Every extension accepted as code, markdown, mermaid, table or svg is text; the rest uses the system guess."""
    suffix = PurePosixPath(relative).suffix.lower()
    if suffix in MIME_OVERRIDES:
        return MIME_OVERRIDES[suffix]
    if EXTENSION_KIND.get(suffix) in ('code', 'markdown', 'mermaid', 'table', 'svg'):
        return 'text/plain; charset=utf-8'
    return mimetypes.guess_type(relative)[0] or 'application/octet-stream'


def is_text(mime):
    return mime.startswith('text/') or mime in TEXT_MIMES


def with_charset(mime):
    return mime + '; charset=utf-8' if is_text(mime) and 'charset' not in mime else mime


def kind_of(relative):
    return EXTENSION_KIND.get(PurePosixPath(relative).suffix.lower())


def scope_ref(info):
    """`(scope_type, scope_id)` of an artifact scope from a resolved conversation scope."""
    if info['kind'] == 'chat':
        return 'chat', info['scope'][5:]
    if info['channel_id'] is not None:
        return 'channel', str(info['channel_id'])
    return 'private', str(info['scope_id'])


def scope_name(scope_type, scope_id):
    return 'private' if scope_type == 'private' else f'{scope_type}-{scope_id}'


def view_of(row):
    return {'id': row['id'], 'scope': scope_name(row['scope_type'], row['scope_id']), 'path': row['path'], 'kind': row['kind'],
            'title': row['title'], 'entry': row['entry'], 'latest_version': row['latest_version'],
            'created_at': row['created_at'], 'updated_at': row['updated_at']}


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def _walk(fd, prefix, depth, found, total):
    """Collect regular files below the pinned directory, never following links; `.git` and `node_modules` are skipped.

    `total` is a one-item running byte count, so an oversized tree is refused before the rest is read.
    """
    if depth > MAX_DEPTH:
        raise ArtifactError(413, 'artifact_too_deep', f'Directory nesting exceeds {MAX_DEPTH} levels')
    for name in sorted(os.listdir(fd)):
        try:
            name.encode('utf-8')
            item = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(item.st_mode):
                if name in SKIPPED_DIRECTORIES:
                    continue
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    _walk(child, prefix + name + '/', depth + 1, found, total)
                finally:
                    os.close(child)
            elif stat.S_ISREG(item.st_mode):
                if len(found) >= MAX_FILES:
                    raise ArtifactError(413, 'artifact_too_many_files', f'An artifact holds at most {MAX_FILES} files')
                if item.st_size > MAX_FILE:
                    raise ArtifactError(413, 'artifact_file_too_large', f'{prefix + name} exceeds 32 MiB')
                if total[0] + item.st_size > MAX_TOTAL:
                    raise ArtifactError(413, 'artifact_too_large', 'An artifact version is limited to 50 MiB in total')
                data = _read(fd, name)
                total[0] += len(data)
                if total[0] > MAX_TOTAL:
                    raise ArtifactError(413, 'artifact_too_large', 'An artifact version is limited to 50 MiB in total')
                found[prefix + name] = data
        except (UnicodeEncodeError, FileNotFoundError):
            continue  # unrepresentable names and files removed mid-walk are not part of the snapshot
        except ArtifactError:
            raise
        except OSError:
            continue  # links raced into place or unreadable entries
    return found


def _read(directory, name):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    with os.fdopen(fd, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise OSError('not a regular file')
        data = stream.read(MAX_FILE + 1)
    if len(data) > MAX_FILE:
        raise ArtifactError(413, 'artifact_file_too_large', f'{name} exceeds 32 MiB')
    return data


def _size_check(files):
    if sum(len(data) for data in files.values()) > MAX_TOTAL:
        raise ArtifactError(413, 'artifact_too_large', 'An artifact version is limited to 50 MiB in total')


class Artifacts:
    def __init__(self, platform):
        self.p = platform
        # Writing blobs for a new version and collecting orphans must not interleave.
        self.blob_lock = threading.Lock()
        # Versions a run re-published unchanged, by durable job id, until its reply is linked.
        self.refs = {}

    # -- storage ---------------------------------------------------------------------------------

    @property
    def blobs(self):
        return self.p.settings.data_dir / 'artifacts' / 'blobs'

    def blob(self, sha):
        if not BLOB.fullmatch(sha):
            raise HTTPException(404, 'Artifact file not found')
        return self.blobs / sha

    def store_blob(self, sha, data):
        path = self.blobs / sha
        if path.exists():
            return
        self.blobs.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(dir=self.blobs, prefix='.incoming-')
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)
        except BaseException:
            Path(temporary).unlink(missing_ok=True)
            raise

    def snapshot(self, info, relative):
        """`(kind, files)` for the workspace-relative path; `files` maps relative paths to bytes. Never follows links."""
        root = info['workspace']
        parts = PurePosixPath(relative).parts
        try:
            parent = open_workspace(root, '/'.join(parts[:-1]), directory=True)
            try:
                item = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
                if stat.S_ISREG(item.st_mode):
                    name = parts[-1]
                    kind = kind_of(name)
                    if kind is None:
                        raise ArtifactError(415, 'artifact_unsupported_kind',
                                            f'Cannot show {PurePosixPath(name).suffix or name} files as artifacts; '
                                            'deliver downloadable files with a standalone MEDIA: line instead')
                    return kind, {name: _read(parent, name)}
                if not stat.S_ISDIR(item.st_mode):
                    raise ArtifactError(400, 'artifact_path_invalid', 'Only regular files and directories can be published')
                directory = os.open(parts[-1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                try:
                    files = _walk(directory, '', 0, {}, [0])
                finally:
                    os.close(directory)
                return 'site', files
            finally:
                os.close(parent)
        except HTTPException as exc:
            if isinstance(exc, ArtifactError):
                raise
            raise ArtifactError(404, 'artifact_path_not_found', 'Path is not inside the workspace or does not exist') from exc
        except OSError as exc:
            raise ArtifactError(404, 'artifact_path_not_found', 'Path does not exist (links are never followed)') from exc

    # -- publishing ------------------------------------------------------------------------------

    def sandbox_path(self, info, value):
        """`(canonical sandbox path, workspace-relative path)` of an absolute sandbox path under the scope's cwd."""
        cwd = info['sandbox'].get('cwd', '/workspace').rstrip('/') + '/'
        if not isinstance(value, str) or not value.startswith(cwd):
            raise ArtifactError(400, 'artifact_path_invalid', f'path must be an absolute sandbox path under {cwd}')
        parts = [part for part in value[len(cwd):].split('/') if part not in ('', '.')]
        if not parts or '..' in parts or '\0' in value:
            raise ArtifactError(400, 'artifact_path_invalid', f'path must name a file or folder inside {cwd}')
        return cwd + '/'.join(parts), '/'.join(parts)

    def publish(self, user, info, value, title=None, entry=None, job_id=None, message_id=None):
        """Snapshot `value` and create the next version unless the latest one is identical: `(view, version, created)`."""
        canonical, relative = self.sandbox_path(info, value)
        if title is not None and (not isinstance(title, str) or len(title.strip()) > 200):
            raise ArtifactError(400, 'artifact_invalid', 'title must be a string of at most 200 characters')
        if entry is not None and not isinstance(entry, str):
            raise ArtifactError(400, 'artifact_invalid', 'entry must be a string')
        kind, files = self.snapshot(info, relative)
        if not files:
            raise ArtifactError(400, 'artifact_empty', 'The folder has no files to publish')
        _size_check(files)
        if kind == 'site':
            entry = '/'.join(PurePosixPath(entry or 'index.html').parts)
            if entry not in files:
                raise ArtifactError(404, 'artifact_entry_not_found', f'The folder has no entry file {entry or "index.html"}; pass entry')
        else:
            entry = next(iter(files))
        manifest = {name: {'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data), 'mime': mime_of(name)}
                    for name, data in files.items()}
        given = (title or '').strip()
        scope_type, scope_id = scope_ref(info)
        with self.blob_lock:
            for name, data in files.items():
                self.store_blob(manifest[name]['sha256'], data)
            with self.p.db.connect() as conn:
                conn.execute('BEGIN IMMEDIATE')
                row = conn.execute('SELECT * FROM artifacts WHERE scope_type=? AND scope_id=? AND path=?',
                                   (scope_type, scope_id, canonical)).fetchone()
                stamp = now()
                if row is None:
                    title = given or PurePosixPath(relative).stem or PurePosixPath(relative).name
                    ident = conn.execute('INSERT INTO artifacts(scope_type,scope_id,owner_user_id,path,kind,title,latest_version,created_at,updated_at) '
                                         'VALUES (?,?,?,?,?,?,0,?,?)', (scope_type, scope_id, user['id'], canonical, kind, title, stamp, stamp)).lastrowid
                    version = 1
                else:
                    ident = row['id']
                    latest = conn.execute('SELECT * FROM artifact_versions WHERE artifact_id=? AND version=?',
                                          (ident, row['latest_version'])).fetchone()
                    if latest and latest['entry'] == entry and json.loads(latest['manifest_json']) == manifest:
                        if given and given != row['title']:
                            conn.execute('UPDATE artifacts SET title=? WHERE id=?', (given, ident))
                        if job_id is not None:
                            self.refs.setdefault(job_id, []).append((ident, row['latest_version']))
                        return self.view(conn, ident), row['latest_version'], False
                    version = row['latest_version'] + 1
                    title = given or row['title']
                conn.execute('INSERT INTO artifact_versions(artifact_id,version,entry,manifest_json,total_size,file_count,message_id,job_id,created_at) '
                             'VALUES (?,?,?,?,?,?,?,?,?)', (ident, version, entry, json.dumps(manifest, sort_keys=True),
                                                           sum(len(data) for data in files.values()), len(manifest),
                                                           message_id, job_id, stamp))
                conn.execute('UPDATE artifacts SET kind=?,title=?,latest_version=?,updated_at=? WHERE id=?', (kind, title, version, stamp, ident))
                view = self.view(conn, ident)
        self.p.queue.emit(info['scope_key'], {'type': 'artifact', 'artifact': view, 'version': version})
        return view, version, True

    def view(self, conn, ident):
        row = conn.execute('SELECT a.*,v.entry FROM artifacts a JOIN artifact_versions v ON v.artifact_id=a.id AND v.version=a.latest_version '
                           'WHERE a.id=?', (ident,)).fetchone()
        return view_of(row)

    def listing(self, info):
        scope_type, scope_id = scope_ref(info)
        with self.p.db.connect() as conn:
            return self.rows(conn, 'a.scope_type=? AND a.scope_id=?', (scope_type, scope_id))

    def rows(self, conn, where, args):
        return [view_of(row) for row in conn.execute(
            'SELECT a.*,v.entry FROM artifacts a JOIN artifact_versions v ON v.artifact_id=a.id AND v.version=a.latest_version '
            f'WHERE {where} ORDER BY a.updated_at DESC, a.id DESC', args)]

    async def gateway(self, user, info, action, args, job_id):
        """The `artifact` tool for root runs in every scope."""
        try:
            if action == 'publish':
                view, version, created = await asyncio.to_thread(self.publish, user, info, args.get('path'), args.get('title'), args.get('entry'), job_id)
                label = f"{view['title']} ({view['kind']}, {view['path']})"
                if created:
                    text = f'Published {label} as version {version}. The user can open it in the artifact panel.'
                else:
                    text = (f'{label} is identical to version {version}; no new version was created. '
                            'The user can open it in the artifact panel.')
                return {'content': text, 'data': {'artifact': view, 'version': version, 'created': created}, 'is_error': False}
            if action == 'list':
                views = self.listing(info)
                lines = [f"{item['title']} [{item['kind']}] v{item['latest_version']} {item['path']}" for item in views]
                return {'content': '\n'.join(lines) or 'No artifacts have been published in this conversation.',
                        'data': {'artifacts': views}, 'is_error': False}
            raise ArtifactError(400, 'artifact_invalid', 'Unsupported artifact action')
        except ArtifactError as exc:
            return {'content': exc.detail, 'data': {'error': exc.code, **exc.payload}, 'is_error': True}
        except HTTPException as exc:
            return {'content': str(exc.detail), 'data': {'error': 'artifact_failed'}, 'is_error': True}

    def link(self, conn, info, message_id, job_id, final=False):
        """Attach the run's versions to its persisted assistant message and list them in `metadata.artifacts`.

        Versions the run published again unchanged create no version; the message references the existing latest one.
        `final` forgets those references once the run's delivery is complete.
        """
        if job_id is None:
            return
        table = 'chat_messages' if info['kind'] == 'chat' else 'messages'
        conn.execute('UPDATE artifact_versions SET message_id=? WHERE job_id=? AND message_id IS NULL', (message_id, job_id))
        rows = [tuple(row) for row in conn.execute(
            'SELECT v.artifact_id,v.version,a.title,a.kind,a.path FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id '
            'WHERE v.job_id=? AND v.message_id=? ORDER BY v.created_at,v.artifact_id,v.version', (job_id, message_id))]
        seen = {(row[0], row[1]) for row in rows}
        refs = self.refs.pop(job_id, []) if final else list(self.refs.get(job_id, []))
        for ident, version in refs:
            if (ident, version) in seen:
                continue
            row = conn.execute('SELECT id,?,title,kind,path FROM artifacts WHERE id=?', (version, ident)).fetchone()
            if row is not None:
                seen.add((ident, version))
                rows.append(tuple(row))
        if not rows:
            return
        metadata = json.loads(conn.execute(f'SELECT metadata_json FROM {table} WHERE id=?', (message_id,)).fetchone()[0])
        metadata['artifacts'] = [{'id': row[0], 'version': row[1], 'title': row[2], 'kind': row[3], 'path': row[4]} for row in rows]
        conn.execute(f'UPDATE {table} SET metadata_json=? WHERE id=?', (json.dumps(metadata), message_id))

    # -- deletion --------------------------------------------------------------------------------

    def delete_scope(self, scope_type, scope_id):
        """Delete a scope's artifacts and every blob no remaining version references."""
        with self.blob_lock, self.p.db.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            doomed = set()
            for row in conn.execute('SELECT v.manifest_json FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id '
                                    'WHERE a.scope_type=? AND a.scope_id=?', (scope_type, scope_id)):
                doomed.update(item['sha256'] for item in json.loads(row[0]).values())
            conn.execute('DELETE FROM artifacts WHERE scope_type=? AND scope_id=?', (scope_type, scope_id))
            for row in conn.execute('SELECT manifest_json FROM artifact_versions'):
                doomed.difference_update(item['sha256'] for item in json.loads(row[0]).values())
            # Unlink while still holding the lock: a publish that dedups against a doomed blob waits and then rewrites it.
            for sha in doomed:
                self.blob(sha).unlink(missing_ok=True)

    # -- view tokens -----------------------------------------------------------------------------

    def sign(self, body):
        return _b64(hmac.new(self.p.settings.session_secret.encode(), b'artifact-view\n' + body.encode(), hashlib.sha256).digest())

    def mint(self, artifact_id, version):
        """`(token, expires_at)`: read access to exactly one version until the expiry."""
        expires = int(time.time()) + TOKEN_TTL
        body = f'{artifact_id}.{version}.{expires}'
        return f'{body}.{self.sign(body)}', datetime.fromtimestamp(expires, timezone.utc).isoformat()

    def verify(self, token):
        """`(artifact id, version)` of a valid unexpired token, else None."""
        parts = token.split('.')
        if len(parts) != 4 or not token.isascii() or not all(part.isdigit() for part in parts[:3]):
            return None
        body = '.'.join(parts[:3])
        if not hmac.compare_digest(self.sign(body).encode(), parts[3].encode()) or int(parts[2]) <= time.time():
            return None
        return int(parts[0]), int(parts[1])

    # -- reading ---------------------------------------------------------------------------------

    def readable(self, user, conn, ident):
        """The artifact row if `user` may read its conversation; any refusal is a plain 404."""
        row = conn.execute('SELECT * FROM artifacts WHERE id=?', (ident,)).fetchone()
        if row is None:
            raise HTTPException(404, 'Artifact not found')
        if row['scope_type'] == 'private' and row['scope_id'] != str(user['id']):
            raise HTTPException(404, 'Artifact not found')
        try:
            self.p.queue.scope(user, scope_name(row['scope_type'], row['scope_id']))
        except HTTPException as exc:
            raise HTTPException(404, 'Artifact not found') from exc
        return row

    def version(self, conn, ident, number):
        row = conn.execute('SELECT * FROM artifact_versions WHERE artifact_id=? AND version=?', (ident, number)).fetchone()
        if row is None:
            raise HTTPException(404, 'Artifact version not found')
        return row, json.loads(row['manifest_json'])


def _ids(request):
    try:
        return int(request.path_params['id']), int(request.path_params.get('version', 0))
    except ValueError as exc:
        raise HTTPException(404, 'Artifact not found') from exc


async def artifacts_list(request):
    p = request.app.state.platform
    user = current_user(request)
    info = p.queue.scope(user, request.query_params.get('scope', 'private'))
    return JSONResponse({'artifacts': p.artifacts.listing(info)})


async def artifact_detail(request):
    p = request.app.state.platform
    user = current_user(request)
    ident, _ = _ids(request)
    with p.db.connect() as conn:
        p.artifacts.readable(user, conn, ident)
        versions = [{'version': row['version'], 'entry': row['entry'], 'created_at': row['created_at'], 'total_size': row['total_size'],
                     'file_count': row['file_count'], 'message_id': row['message_id']}
                    for row in conn.execute('SELECT * FROM artifact_versions WHERE artifact_id=? ORDER BY version DESC', (ident,))]
        return JSONResponse({'artifact': p.artifacts.view(conn, ident), 'versions': versions})


async def artifact_files(request):
    p = request.app.state.platform
    user = current_user(request)
    ident, number = _ids(request)
    with p.db.connect() as conn:
        p.artifacts.readable(user, conn, ident)
        row, manifest = p.artifacts.version(conn, ident, number)
    return JSONResponse({'entry': row['entry'], 'files': [{'path': name, 'size': item['size'], 'mime': item['mime']}
                                                          for name, item in sorted(manifest.items())]})


async def artifact_source(request):
    p = request.app.state.platform
    user = current_user(request)
    ident, number = _ids(request)
    with p.db.connect() as conn:
        p.artifacts.readable(user, conn, ident)
        row, manifest = p.artifacts.version(conn, ident, number)
    name = request.query_params.get('path') or row['entry']
    item = manifest.get(name)
    if item is None:
        raise HTTPException(404, 'Artifact file not found')
    if not is_text(item['mime']):
        raise ArtifactError(415, 'artifact_not_text', 'Only text files have a source view')
    try:
        with p.artifacts.blob(item['sha256']).open('rb') as stream:
            data = stream.read(SOURCE_LIMIT + 1)
    except OSError as exc:
        raise HTTPException(404, 'Artifact file not found') from exc
    truncated = len(data) > SOURCE_LIMIT
    content = codecs.getincrementaldecoder('utf-8')(errors='replace').decode(data[:SOURCE_LIMIT], final=not truncated)
    return JSONResponse({'content': content, 'truncated': truncated, 'mime': item['mime']})


async def artifact_download(request):
    p = request.app.state.platform
    user = current_user(request)
    ident, number = _ids(request)
    with p.db.connect() as conn:
        artifact = p.artifacts.readable(user, conn, ident)
        row, manifest = p.artifacts.version(conn, ident, number)
    headers = {'Content-Security-Policy': 'sandbox'}
    if artifact['kind'] != 'site':
        name, item = next(iter(manifest.items()))
        path = p.artifacts.blob(item['sha256'])
        if not path.is_file():
            raise HTTPException(404, 'Artifact file not found')
        return FileResponse(path, media_type=with_charset(item['mime']), filename=name, content_disposition_type='attachment', headers=headers)
    filename = f"{PurePosixPath(artifact['path']).name or artifact['title']}-v{number}.zip"
    data = await asyncio.to_thread(_zip, p.artifacts, manifest, row['created_at'])
    return Response(data, media_type='application/zip', headers={
        **headers, 'Content-Disposition': "attachment; filename*=UTF-8''" + quote(filename)})


def _zip(artifacts, manifest, created_at):
    stamp = datetime.fromisoformat(created_at).timetuple()[:6]
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, item in sorted(manifest.items()):
            info = zipfile.ZipInfo(name, date_time=stamp if stamp[0] >= 1980 else (1980, 1, 1, 0, 0, 0))
            info.external_attr = 0o644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            try:
                archive.writestr(info, artifacts.blob(item['sha256']).read_bytes())
            except OSError as exc:
                raise HTTPException(404, 'Artifact file not found') from exc
    return buffer.getvalue()


async def artifact_view_url(request):
    p = request.app.state.platform
    user = current_user(request)
    ident, number = _ids(request)
    with p.db.connect() as conn:
        p.artifacts.readable(user, conn, ident)
        row, _ = p.artifacts.version(conn, ident, number)
    token, expires = p.artifacts.mint(ident, number)
    return JSONResponse({'url': f"/artifact-view/{token}/{quote(row['entry'])}", 'expires_at': expires})


async def artifact_view(request):
    """Serve one version's tree to a bearer view token: no cookies, opaque-origin sandbox, a bad token is a plain 404."""
    p = request.app.state.platform
    granted = p.artifacts.verify(request.path_params['token'])
    if granted is None:
        raise HTTPException(404, 'Not found')
    with p.db.connect() as conn:
        try:
            row, manifest = p.artifacts.version(conn, *granted)
        except HTTPException:
            raise HTTPException(404, 'Not found') from None
    parts = [part for part in request.path_params.get('path', '').split('/') if part]
    if any(part in ('..', '.') or '\\' in part or '\0' in part for part in parts):
        raise HTTPException(404, 'Not found')
    relative = '/'.join(parts)
    if relative not in manifest:
        directory = relative + '/' if relative else ''
        index = directory + 'index.html'
        if index in manifest:
            if relative and not request.url.path.endswith('/'):
                return RedirectResponse(request.url.path + '/' + ('?' + request.url.query if request.url.query else ''), status_code=307)
            relative = index
        elif not relative:
            relative = row['entry']
        else:
            raise HTTPException(404, 'Not found')
    item = manifest.get(relative)
    path = p.artifacts.blob(item['sha256']) if item else None
    if path is None or not path.is_file():
        raise HTTPException(404, 'Not found')
    return FileResponse(path, media_type=with_charset(item['mime']), headers={
        'Content-Security-Policy': VIEW_CSP, 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin',
        'Cache-Control': 'private, max-age=7200', 'X-Frame-Options': 'SAMEORIGIN'})


def routes():
    return [Route('/api/artifacts', artifacts_list), Route('/api/artifacts/{id}/versions/{version}/files', artifact_files),
            Route('/api/artifacts/{id}/versions/{version}/source', artifact_source),
            Route('/api/artifacts/{id}/versions/{version}/download', artifact_download),
            Route('/api/artifacts/{id}/versions/{version}/view', artifact_view_url, methods=['POST']),
            Route('/api/artifacts/{id}', artifact_detail), Route('/artifact-view/{token}/{path:path}', artifact_view)]
