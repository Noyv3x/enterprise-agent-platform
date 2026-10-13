"""Scope-bound attachments and workspace downloads."""
import asyncio
import base64
import hashlib
import codecs
import hmac
import io
import mimetypes
import os
import stat
import re
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import quote
from contextlib import nullcontext
from pathlib import Path

from PIL import Image, UnidentifiedImageError
from starlette.exceptions import HTTPException
from starlette.responses import FileResponse, JSONResponse, Response, StreamingResponse
from starlette.routing import Route

from .auth import current_user
from .db import now
from .file_viewer import CORS, OFFICE_KINDS, VIEW_HEADERS, shell, wants_lang, wants_raw

MAX_FILE = 32 * 1024 * 1024
# A MEDIA delivery of these viewable kinds publishes an artifact version; images and other files stay attachments.
MEDIA_ARTIFACT_EXTENSIONS = frozenset({'.html', '.htm', '.md', '.markdown', '.svg', '.mmd', '.mermaid', '.csv', '.tsv',
                                       '.docx', '.xlsx', '.pptx', '.pdf'})
VIEW_TOKEN_TTL = 7200
TEXT_VIEW_LIMIT = 2 * 1024 * 1024
TEXT_VIEW_KINDS = ('web', 'markdown', 'mermaid', 'table', 'code')


def contained(root, value):
    root = Path(root).resolve()
    path = (root / value).resolve()
    if not path.is_relative_to(root):
        raise HTTPException(403, 'Path escapes workspace')
    return path


def open_workspace(root, value, directory=False):
    """Walk relative components with pinned directory descriptors; never follow links."""
    parts = Path(value).parts
    if Path(value).is_absolute() or '..' in parts:
        raise HTTPException(403, 'Path escapes workspace')
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for index, part in enumerate(parts):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if index < len(parts) - 1 or directory:
                flags |= os.O_DIRECTORY
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        mode = os.fstat(fd).st_mode
        if not (stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode)):
            raise HTTPException(403, 'Not a regular workspace file')
        return fd
    except BaseException:
        os.close(fd)
        raise


def ensure_workspace(root, path):
    """Create path under root one pinned component at a time, never following links."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(root, flags)
    try:
        for name in Path(path).relative_to(root).parts:
            if name in ('.', '..'):
                raise ValueError('Invalid workspace directory')
            try:
                os.mkdir(name, mode=0o700, dir_fd=fd)
            except FileExistsError:
                pass
            child = os.open(name, flags, dir_fd=fd)
            os.close(fd)
            fd = child
    finally:
        os.close(fd)


def bounded_read(fd):
    with os.fdopen(fd, 'rb') as stream:
        data = stream.read(MAX_FILE + 1)
    if len(data) > MAX_FILE:
        raise HTTPException(413, 'File exceeds 32 MiB')
    return data


def descriptor_response(fd, filename, mime='application/octet-stream'):
    def chunks():
        with os.fdopen(fd, 'rb') as stream:
            while chunk := stream.read(65536):
                yield chunk
    return StreamingResponse(chunks(), media_type=mime, headers={
        'Content-Disposition': "attachment; filename*=UTF-8''" + quote(filename),
        'Content-Length': str(os.fstat(fd).st_size)})


def view_kind(filename, mime):
    """How the panel shows an attachment: `pdf|docx|xlsx|pptx|image|text|other` (by file name first, then MIME type)."""
    from .artifacts import EXTENSION_KIND, TEXT_MIMES
    suffix = Path(filename).suffix.lower()
    if suffix in ('.docx', '.xlsx', '.pptx'):
        return suffix[1:]
    if suffix == '.pdf' or mime == 'application/pdf':
        return 'pdf'
    if mime.startswith('image/'):
        return 'image'
    if mime.startswith('text/') or mime in TEXT_MIMES or EXTENSION_KIND.get(suffix) in TEXT_VIEW_KINDS:
        return 'text'
    return 'other'


def attachment(row, chat=False):
    ident = -row['id'] if chat else row['id']
    kind = view_kind(row['filename'], row['mime_type'])
    return {'id': ident, 'filename': row['filename'], 'mime_type': row['mime_type'], 'size_bytes': row['size_bytes'],
            'url': f'/api/attachments/{ident}', 'preview_url': f'/api/attachments/{ident}/preview' if row['mime_type'].startswith('image/') else None,
            'view_kind': kind}


class Files:
    def __init__(self, platform):
        self.p = platform

    def table(self, info):
        return 'chat_attachments' if info['kind'] == 'chat' else 'attachments'

    def storage(self, row):
        return self.p.settings.data_dir / 'attachments' / row['storage_path']

    def find(self, ident, conn):
        chat = ident < 0
        table = 'chat_attachments' if chat else 'attachments'
        row = conn.execute(f'SELECT * FROM {table} WHERE id=?', (abs(ident),)).fetchone()
        if not row and not chat:
            row = conn.execute('SELECT * FROM pending_attachments WHERE id=?', (ident,)).fetchone()
        if not row:
            raise HTTPException(404, 'Attachment not found')
        return row, chat

    def owned(self, user, ident, conn):
        row, chat = self.find(ident, conn)
        if row['message_id'] is None and row['uploader_user_id'] != user['id']:
            raise HTTPException(404, 'Attachment not found')
        scope = 'chat-' + row['conversation_id'] if chat else ('private' if row['scope_type'] == 'private' else 'channel-' + str(row['scope_id']))
        info = self.p.queue.scope(user, scope)
        if not chat and (info['scope_type'] != row['scope_type'] or str(info['scope_id']) != str(row['scope_id'])):
            raise HTTPException(404, 'Attachment not found')
        return row, info

    # -- view tokens -----------------------------------------------------------------------------

    def sign(self, body, sha256):
        # The file's content hash is signed but not carried: a token stops working if the id is ever reused for other bytes.
        digest = hmac.new(self.p.settings.session_secret.encode(), b'attachment-view\n' + body.encode() + b'\n' + sha256.encode(), hashlib.sha256).digest()
        return base64.urlsafe_b64encode(digest).rstrip(b'=').decode()

    def mint(self, ident, sha256):
        """`(token, expires_at)`: read access to exactly one attachment for 2 h; stateless, no user identity."""
        expires = int(time.time()) + VIEW_TOKEN_TTL
        body = f'{ident}.{expires}'
        return f'{body}.{self.sign(body, sha256)}', datetime.fromtimestamp(expires, timezone.utc).isoformat()

    def grant(self, token):
        """`(attachment id, expiry, signature)` of a well-formed unexpired token, else None; `verify` checks the signature."""
        parts = token.split('.')
        if len(parts) != 3 or not token.isascii() or not re.fullmatch(r'-?\d+', parts[0]) or not parts[1].isdigit() or int(parts[1]) <= time.time():
            return None
        return int(parts[0]), parts[1], parts[2]

    def verify(self, granted, row):
        ident, expires, signature = granted
        return hmac.compare_digest(self.sign(f'{ident}.{expires}', row['sha256']).encode(), signature.encode())

    def alive(self, ident, row, conn):
        """A view token follows its conversation: a deleted chat or archived channel serves nothing, like the download route."""
        if ident < 0:
            return conn.execute('SELECT 1 FROM chat_conversations WHERE id=? AND deleted_at IS NULL', (row['conversation_id'],)).fetchone() is not None
        if row['scope_type'] == 'channel':
            return conn.execute('SELECT 1 FROM channels WHERE id=? AND archived=0', (row['scope_id'],)).fetchone() is not None
        return True

    def bind(self, user, info, message_id, attachment_ids, conn=None):
        with nullcontext(conn) if conn is not None else self.p.db.connect() as db:
            image_bytes = 0
            for ident in dict.fromkeys(attachment_ids):
                row, actual = self.owned(user, ident, db)
                if actual['scope_key'] != info['scope_key'] or row['uploader_user_id'] != user['id'] or row['message_id'] is not None:
                    raise HTTPException(403, 'Attachment cannot be attached to this message')
                if row['mime_type'].startswith('image/'):
                    image_bytes += row['size_bytes']
                    if image_bytes > 12 * 1024 * 1024:
                        raise HTTPException(413, 'Attached images exceed 12 MiB total; use smaller images')
                if info['kind'] == 'chat':
                    db.execute('UPDATE chat_attachments SET message_id=? WHERE id=?', (message_id, row['id']))
                else:
                    values = dict(row)
                    values['message_id'] = message_id
                    columns = ','.join(values)
                    db.execute(f"INSERT INTO attachments({columns}) VALUES({','.join('?' for _ in values)})", tuple(values.values()))
                    db.execute('DELETE FROM pending_attachments WHERE id=?', (row['id'],))

    def for_message(self, info, message_id):
        with self.p.db.connect() as conn:
            rows = conn.execute(f'SELECT * FROM {self.table(info)} WHERE message_id=? ORDER BY id', (message_id,)).fetchall()
        return [attachment(row, info['kind'] == 'chat') for row in rows]

    def release(self, info, message_id, conn):
        """Undo `bind` for a withdrawn message: the uploads stay owned by their uploader and can be attached again by id."""
        if info['kind'] == 'chat':
            conn.execute('UPDATE chat_attachments SET message_id=NULL WHERE message_id=?', (message_id,))
            return
        for row in conn.execute('SELECT * FROM attachments WHERE message_id=? ORDER BY id', (message_id,)).fetchall():
            values = dict(row)
            values['message_id'] = None
            conn.execute(f"INSERT INTO pending_attachments({','.join(values)}) VALUES({','.join('?' for _ in values)})", tuple(values.values()))
        conn.execute('DELETE FROM attachments WHERE message_id=?', (message_id,))

    def prompt(self, user, info, attachment_ids):
        lines, images = [], []
        with self.p.db.connect() as conn:
            for ident in attachment_ids:
                row, actual = self.owned(user, ident, conn)
                if actual['scope_key'] != info['scope_key']:
                    raise HTTPException(403, 'Attachment belongs to another scope')
                path = self.storage(row)
                relative = Path('uploads') / path.name
                root = Path(info['workspace'])
                root.mkdir(parents=True, exist_ok=True)
                rootfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                try:
                    try:
                        os.mkdir('uploads', dir_fd=rootfd)
                    except FileExistsError:
                        pass
                    directory = os.open('uploads', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=rootfd)
                    try:
                        fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600, dir_fd=directory)
                        with os.fdopen(fd, 'wb') as output:
                            output.write(path.read_bytes())
                    finally:
                        os.close(directory)
                finally:
                    os.close(rootfd)
                prefix = info['sandbox'].get('cwd', '/workspace').rstrip('/')
                lines.append(f"Attachment {row['filename']}: {prefix}/{relative}")
                if row['mime_type'].startswith('image/'):
                    images.append({'mime': row['mime_type'], 'data': base64.b64encode(path.read_bytes()).decode()})
        return {'text': '\n'.join(lines), 'images': images}

    def store(self, user, info, filename, data, source='upload', message_id=None):
        filename = Path(filename).name or 'file'
        mime = mimetypes.guess_type(filename)[0] or 'application/octet-stream'
        folder = self.p.settings.data_dir / 'attachments'
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / (uuid.uuid4().hex + '-' + filename)
        path.write_bytes(data)
        timestamp = now() if info['kind'] == 'chat' else int(time.time())
        common = (message_id, user['id'], source, filename, path.name, mime, len(data), hashlib.sha256(data).hexdigest(), timestamp)
        try:
            with self.p.db.connect() as conn:
                conn.execute('BEGIN IMMEDIATE')
                table = self.table(info)
                if info['kind'] == 'chat':
                    cursor = conn.execute('INSERT INTO chat_attachments(conversation_id,message_id,uploader_user_id,source,filename,storage_path,mime_type,size_bytes,sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', (info['scope_id'], *common))
                else:
                    table = 'pending_attachments' if message_id is None else 'attachments'
                    ident = conn.execute('SELECT MAX(id) FROM (SELECT id FROM attachments UNION ALL SELECT id FROM pending_attachments)').fetchone()[0] or 0
                    cursor = conn.execute(f'INSERT INTO {table}(id,scope_type,scope_id,message_id,uploader_user_id,source,filename,storage_path,mime_type,size_bytes,sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', (ident + 1, info['scope_type'], info['scope_id'], *common))
                row = conn.execute(f'SELECT * FROM {table} WHERE id=?', (cursor.lastrowid,)).fetchone()
        except Exception:
            path.unlink(missing_ok=True)
            raise
        return attachment(row, info['kind'] == 'chat')

    async def deliver(self, user, scope_info, message_id, text, job_id=None):
        """Store MEDIA files as attachments, except the viewable kinds (text, Office, PDF), which publish artifact versions."""
        delivered = []
        for value in dict.fromkeys(re.findall(r'^MEDIA:\s*(.+?)\s*$', text, flags=re.MULTILINE)):
            cwd = scope_info['sandbox'].get('cwd', '/workspace').rstrip('/') + '/'
            if not value.startswith(cwd):
                continue
            try:
                relative = value[len(cwd):]
                if Path(relative).suffix.lower() in MEDIA_ARTIFACT_EXTENSIONS:
                    await asyncio.to_thread(self.p.artifacts.publish, user, scope_info, value, None, None, job_id, message_id)
                    continue
                data = bounded_read(open_workspace(scope_info['workspace'], relative))
                delivered.append(self.store(user, scope_info, Path(relative).name, data, 'agent_generated', message_id))
            except (HTTPException, OSError):
                continue
        return delivered


async def upload(request):
    p = request.app.state.platform
    user = current_user(request)
    info = p.queue.scope(user, request.query_params.get('scope', 'private'))
    # Bound the complete multipart body before allowing the parser to spool files.
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_FILE + 65536:
            raise HTTPException(413, 'Upload exceeds 32 MiB')
    request._body = bytes(body)
    async with request.form(max_files=1, max_fields=1) as form:
        file = form.get('file')
        if file is None or not hasattr(file, 'read'):
            raise HTTPException(400, 'Multipart file is required')
        data = await file.read(MAX_FILE + 1)
        if len(data) > MAX_FILE:
            raise HTTPException(413, 'Upload exceeds 32 MiB')
        return JSONResponse({'attachment': p.files.store(user, info, file.filename, data)})


async def download(request):
    p = request.app.state.platform
    user = current_user(request)
    try:
        ident = int(request.path_params['id'])
    except ValueError as exc:
        raise HTTPException(404, 'Attachment not found') from exc
    with p.db.connect() as conn:
        row, _ = p.files.owned(user, ident, conn)
    path = p.files.storage(row)
    if not path.is_file():
        raise HTTPException(404, 'Attachment bytes not found')
    if request.url.path.endswith('/preview'):
        if not row['mime_type'].startswith('image/'):
            raise HTTPException(415, 'No preview for this file type')
        try:
            with Image.open(path) as image:
                image.thumbnail((1600, 1600))
                stream = io.BytesIO()
                image.convert('RGB').save(stream, 'PNG')
        except (UnidentifiedImageError, OSError, ValueError) as exc:
            raise HTTPException(422, 'Cannot preview this document') from exc
        return Response(stream.getvalue(), media_type='image/png')
    return descriptor_response(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), row['filename'], row['mime_type'])


async def attachment_view_url(request):
    """Mint a view token under the download's own authorization (ownership, scope, pending uploads, chat ids)."""
    p = request.app.state.platform
    user = current_user(request)
    try:
        ident = int(request.path_params['id'])
    except ValueError as exc:
        raise HTTPException(404, 'Attachment not found') from exc
    with p.db.connect() as conn:
        row, _ = p.files.owned(user, ident, conn)
    if not p.files.storage(row).is_file():
        raise HTTPException(404, 'Attachment bytes not found')
    token, expires = p.files.mint(ident, row['sha256'])
    return JSONResponse({'url': f"/attachment-view/{token}/{quote(row['filename'])}", 'kind': view_kind(row['filename'], row['mime_type']),
                         'expires_at': expires})


async def attachment_view(request):
    """Serve one attachment to a bearer view token: no cookies; Office files as the sandboxed viewer page (bytes with `?raw=1`)."""
    p = request.app.state.platform
    granted = p.files.grant(request.path_params['token'])
    if granted is None:
        raise HTTPException(404, 'Not found')
    with p.db.connect() as conn:
        try:
            row, _ = p.files.find(granted[0], conn)
        except HTTPException:
            raise HTTPException(404, 'Not found') from None
        if not p.files.verify(granted, row) or not p.files.alive(granted[0], row, conn):
            raise HTTPException(404, 'Not found')
    path = p.files.storage(row)
    if not path.is_file():
        raise HTTPException(404, 'Not found')
    kind = view_kind(row['filename'], row['mime_type'])
    # Only the Office bytes fetched by the opaque-origin viewer need CORS; every other answer is read as a document, not fetched.
    headers = {**{name: value for name, value in VIEW_HEADERS.items() if name not in CORS}, 'Cache-Control': 'private, max-age=7200'}
    if kind in OFFICE_KINDS:
        if not wants_raw(request):
            return shell(kind, row['filename'], lang=wants_lang(request))
        return FileResponse(path, media_type=row['mime_type'], headers={**headers, **CORS})
    if kind == 'text':
        with path.open('rb') as stream:
            data = stream.read(TEXT_VIEW_LIMIT + 1)
        text = codecs.getincrementaldecoder('utf-8')(errors='replace').decode(data[:TEXT_VIEW_LIMIT], final=len(data) <= TEXT_VIEW_LIMIT)
        return Response(text, media_type='text/plain; charset=utf-8', headers=headers)
    if kind == 'other':
        return FileResponse(path, media_type='application/octet-stream', filename=row['filename'], content_disposition_type='attachment',
                            headers={**headers, 'Content-Security-Policy': 'sandbox'})
    return FileResponse(path, media_type='application/pdf' if kind == 'pdf' else row['mime_type'], headers=headers)


async def workspace(request):
    p = request.app.state.platform
    info = p.queue.scope(current_user(request), 'private')
    relative = request.query_params.get('path', '')
    try:
        if request.url.path.endswith('/download'):
            return descriptor_response(open_workspace(info['workspace'], relative), Path(relative).name)
        fd = open_workspace(info['workspace'], relative, directory=True)
        rows = []
        try:
            for name in sorted(os.listdir(fd)):
                item = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if not (stat.S_ISREG(item.st_mode) or stat.S_ISDIR(item.st_mode)):
                    continue
                rows.append({'name': name, 'path': str(Path(relative) / name), 'is_dir': stat.S_ISDIR(item.st_mode), 'size_bytes': item.st_size if stat.S_ISREG(item.st_mode) else 0})
        finally:
            os.close(fd)
    except OSError as exc:
        raise HTTPException(404, 'Workspace file not found') from exc
    return JSONResponse({'files': rows})


def routes():
    return [Route('/api/attachments', upload, methods=['POST']), Route('/api/attachments/{id}/preview', download),
            Route('/api/attachments/{id}/view', attachment_view_url, methods=['POST']),
            Route('/attachment-view/{token}/{name:path}', attachment_view), Route('/api/attachments/{id}', download), Route('/api/workspace/files', workspace), Route('/api/workspace/download', workspace)]
