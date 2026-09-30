"""Scope-bound attachments and workspace downloads."""
import base64
import hashlib
import io
import mimetypes
import os
import stat
import re
import time
import uuid
import zipfile
from xml.etree import ElementTree
from urllib.parse import quote
from contextlib import nullcontext
from pathlib import Path

from PIL import Image, UnidentifiedImageError
from pypdf import PdfReader
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

from .auth import current_user
from .db import now

MAX_FILE = 32 * 1024 * 1024


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


def office_preview(data, suffix):
    """Bounded text-only OOXML extraction; no archive extraction or external entities."""
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > 2048 or sum(item.file_size for item in entries) > 64 * 1024 * 1024:
            raise ValueError('Office archive exceeds preview limits')
        names = set(archive.namelist())
        def xml(name):
            item = archive.getinfo(name)
            if item.file_size > 8 * 1024 * 1024 or item.flag_bits & 1:
                raise ValueError('Office XML exceeds preview limits')
            raw = archive.read(name)
            declarations = raw.replace(b'\x00', b'').upper()
            if b'<!DOCTYPE' in declarations or b'<!ENTITY' in declarations:
                raise ValueError('XML entities are forbidden')
            return ElementTree.fromstring(raw)
        def texts(node):
            return ''.join(item.text or '' for item in node.iter() if item.tag.rsplit('}', 1)[-1] == 't')[:1000]
        lines = []
        if suffix == '.docx':
            for node in xml('word/document.xml').iter():
                if node.tag.rsplit('}', 1)[-1] == 'p':
                    lines.append(texts(node))
                    if len(lines) >= 100:
                        break
        elif suffix == '.pptx':
            slides = sorted((name for name in names if re.fullmatch(r'ppt/slides/slide\d+\.xml', name)), key=lambda name: int(re.search(r'(\d+)\.xml', name)[1]))
            for index, name in enumerate(slides[:12], 1):
                lines.append(f'Slide {index}')
                lines.extend(texts(node) for node in xml(name).iter() if node.tag.rsplit('}', 1)[-1] == 'p')
        else:
            shared = [texts(node) for node in xml('xl/sharedStrings.xml') if node.tag.rsplit('}', 1)[-1] == 'si'] if 'xl/sharedStrings.xml' in names else []
            sheets = sorted(name for name in names if re.fullmatch(r'xl/worksheets/sheet\d+\.xml', name))
            for name in sheets[:5]:
                lines.append(name.rsplit('/', 1)[-1])
                for row in [node for node in xml(name).iter() if node.tag.rsplit('}', 1)[-1] == 'row'][:100]:
                    cells = []
                    for cell in list(row)[:30]:
                        value = next((node.text or '' for node in cell if node.tag.rsplit('}', 1)[-1] == 'v'), '')
                        if cell.get('t') == 's':
                            value = shared[int(value)]
                        elif cell.get('t') == 'inlineStr':
                            value = texts(cell)
                        cells.append(value[:1000])
                    lines.append('\t'.join(cells))
        return '\n'.join(lines)[:100000]


def attachment(row, chat=False):
    ident = -row['id'] if chat else row['id']
    preview = row['mime_type'].startswith(('image/', 'text/')) or row['mime_type'] == 'application/pdf' or Path(row['filename']).suffix.lower() in {'.docx', '.xlsx', '.pptx'}
    return {'id': ident, 'filename': row['filename'], 'mime_type': row['mime_type'], 'size_bytes': row['size_bytes'],
            'url': f'/api/attachments/{ident}', 'preview_url': f'/api/attachments/{ident}/preview' if preview else None}


class Files:
    def __init__(self, platform):
        self.p = platform

    def table(self, info):
        return 'chat_attachments' if info['kind'] == 'chat' else 'attachments'

    def storage(self, row):
        return self.p.settings.data_dir / 'attachments' / row['storage_path']

    def owned(self, user, ident, conn):
        chat = ident < 0
        table = 'chat_attachments' if chat else 'attachments'
        row = conn.execute(f'SELECT * FROM {table} WHERE id=?', (abs(ident),)).fetchone()
        if not row and not chat:
            row = conn.execute('SELECT * FROM pending_attachments WHERE id=?', (ident,)).fetchone()
        if not row:
            raise HTTPException(404, 'Attachment not found')
        if row['message_id'] is None and row['uploader_user_id'] != user['id']:
            raise HTTPException(404, 'Attachment not found')
        scope = 'chat-' + row['conversation_id'] if chat else ('private' if row['scope_type'] == 'private' else 'channel-' + str(row['scope_id']))
        info = self.p.queue.scope(user, scope)
        if not chat and (info['scope_type'] != row['scope_type'] or str(info['scope_id']) != str(row['scope_id'])):
            raise HTTPException(404, 'Attachment not found')
        return row, info

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

    async def deliver(self, user, scope_info, message_id, text):
        delivered = []
        for value in dict.fromkeys(re.findall(r'^MEDIA:\s*(.+?)\s*$', text, flags=re.MULTILINE)):
            cwd = scope_info['sandbox'].get('cwd', '/workspace').rstrip('/') + '/'
            if not value.startswith(cwd):
                continue
            try:
                relative = value[len(cwd):]
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
        try:
            if row['mime_type'].startswith('image/'):
                with Image.open(path) as image:
                    image.thumbnail((1600, 1600))
                    stream = io.BytesIO()
                    image.convert('RGB').save(stream, 'PNG')
                return Response(stream.getvalue(), media_type='image/png')
            if row['mime_type'] == 'application/pdf':
                PdfReader(path)
                return Response(path.read_bytes(), media_type='application/pdf', headers={'Content-Security-Policy': "sandbox"})
            suffix = Path(row['filename']).suffix.lower()
            if suffix in {'.docx', '.xlsx', '.pptx'}:
                return Response(office_preview(path.read_bytes(), suffix), media_type='text/plain')
            if row['mime_type'].startswith('text/'):
                with path.open('rb') as stream:
                    text = stream.read(100000).decode('utf-8', errors='replace')
                return Response(text, media_type='text/plain')
        except (UnidentifiedImageError, OSError, ValueError, KeyError, IndexError, zipfile.BadZipFile, ElementTree.ParseError) as exc:
            raise HTTPException(422, 'Cannot preview this document') from exc
        raise HTTPException(415, 'No preview for this file type')
    return descriptor_response(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), row['filename'], row['mime_type'])


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
            Route('/api/attachments/{id}', download), Route('/api/workspace/files', workspace), Route('/api/workspace/download', workspace)]
