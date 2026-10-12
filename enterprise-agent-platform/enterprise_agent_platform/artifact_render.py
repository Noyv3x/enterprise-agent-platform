"""Artifact screenshots through Camofox, under a dedicated renderer identity per call.

Used by the AI's `artifact view` self-check and by annotate capture. The renderer never touches the user's own browser
context (`private:<uid>`): every render creates `artifact-render:<uuid>`, navigates only a URL Platform built from an
authorized artifact version or live preview, and deletes the whole session in a `finally`.
"""
import asyncio
import io
import json
import logging
import math
import re
import time
import uuid
from dataclasses import dataclass
from urllib.parse import quote

import httpx
from PIL import Image

from .artifacts import RENDER_QUERY, ArtifactError

log = logging.getLogger(__name__)

GLOBAL_RENDERS = 2
QUEUE_SECONDS = 30
SETTLE_SECONDS = 8
MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_PIXELS = 100_000_000
MAX_CLIP_WIDTH = 4096
MAX_SEGMENTS = 8
MAX_IMAGE_WIDTH = 1280
JPEG_QUALITY = 70
RATE_LIMIT = 30
RATE_WINDOW = 60
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
# The trusted expressions run in the artifact's own (opaque-origin, page-controlled) realm, so they are synchronous and return plain
# arrays: no Promise, timers, iframes or JSON, nothing a page can stall or that needs another realm. Waiting happens on the Platform
# side by polling, and every result is parsed defensively because a hostile page may return anything.
STATE = "[document.readyState, document.fonts ? document.fonts.status : 'loaded']"
PAGE_INFO = ("[location.href, Math.max(document.documentElement ? document.documentElement.scrollWidth : 0, document.body ? document.body.scrollWidth : 0),"
             "Math.max(document.documentElement ? document.documentElement.scrollHeight : 0, document.body ? document.body.scrollHeight : 0),"
             "Array.isArray(window.__eapLog) ? window.__eapLog.slice(0, 50) : []]")
LOCATION = "[location.href]"
EVALUATE_SECONDS = 3
SETTLE_POLL = 0.25
SETTLE_PAUSE = 0.3
GUARD = re.compile(r'^/(?:artifact-view|artifact-live)/[^/?#]+/')
# Tokens and capability ids never reach model-visible text: `http://base/artifact-view/<token>/x.js` becomes `/x.js`.
CONSOLE_URL = re.compile(r'(?:[A-Za-z][A-Za-z0-9+.-]*://[^/\s]+)?/artifact-(?:view|live)/[A-Za-z0-9._-]+/')


def clean_console(entry):
    return CONSOLE_URL.sub('/', str(entry))[:500]


def unavailable(detail='The screenshot service is unavailable'):
    return ArtifactError(503, 'render_unavailable', detail)


@dataclass
class Render:
    image: bytes
    page_width: int
    page_height: int
    log: list


class Renderer:
    def __init__(self, platform):
        self.p = platform
        self.slots = None
        self.users = {}
        self.history = {}

    async def _call(self, method, path, body=None, params=None, binary=False, timeout=60):
        settings = self.p.settings
        options = {'json': body} if body is not None else {'params': params} if params else {}
        try:
            async with asyncio.timeout(timeout), self.p.http.stream(
                    method, settings.camofox_url.rstrip('/') + path, headers={'Authorization': 'Bearer ' + settings.camofox_access_key},
                    timeout=min(30, timeout), **options) as response:
                if response.status_code >= 400:
                    raise unavailable(f'The screenshot service answered HTTP {response.status_code}')
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > (MAX_IMAGE_BYTES if binary else 1024 * 1024):
                        raise ArtifactError(413, 'render_too_large', 'The page is too large to render as one screenshot')
        except (httpx.HTTPError, TimeoutError, OSError) as exc:
            raise unavailable() from exc
        if binary:
            return bytes(data)
        try:
            decoded = json.loads(data) if data else {}
        except ValueError as exc:
            raise unavailable('The screenshot service answered invalid JSON') from exc
        if not isinstance(decoded, dict):
            raise unavailable('The screenshot service answered an unexpected value')
        return decoded

    async def _forget(self, identity):
        try:
            await self._call('DELETE', '/sessions/' + quote(identity, safe=''))
        except Exception as exc:  # cleanup must never mask the render's own outcome
            log.warning('Could not delete renderer session %s: %s', identity, exc)

    def throttle(self, user_id):
        """Per-user sliding-window rate limit, checked before a render may even queue."""
        stamps = [stamp for stamp in self.history.get(user_id, ()) if stamp > time.monotonic() - RATE_WINDOW]
        if len(stamps) >= RATE_LIMIT:
            self.history[user_id] = stamps
            raise ArtifactError(429, 'render_rate_limited', f'At most {RATE_LIMIT} renders a minute; wait a little before the next one')
        stamps.append(time.monotonic())
        self.history[user_id] = stamps

    async def acquire(self, user_id):
        if self.slots is None:
            self.slots = asyncio.Semaphore(GLOBAL_RENDERS)
        self.throttle(user_id)
        lock = self.users.setdefault(user_id, asyncio.Lock())
        try:
            async with asyncio.timeout(QUEUE_SECONDS):
                await lock.acquire()
                try:
                    await self.slots.acquire()
                except BaseException:
                    lock.release()
                    raise
        except TimeoutError as exc:
            raise unavailable('The renderer is busy; try again shortly') from exc
        return lock

    async def evaluate(self, base, identity, expression, timeout=EVALUATE_SECONDS):
        """The list a synchronous trusted expression returned; anything else (garbage from a hostile page) is `[]`."""
        info = await self._call('POST', base + '/evaluate', {'userId': identity, 'expression': expression}, timeout=timeout)
        result = info.get('result')
        return result if isinstance(result, list) else []

    async def settle(self, base, identity):
        """Wait, at most SETTLE_SECONDS, for the document to be complete with fonts loaded, then pause briefly. An evaluate that
        fails or times out ends the wait: settling only affects timing, never what may be screenshotted."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + SETTLE_SECONDS
        try:
            while loop.time() < deadline:
                state = await self.evaluate(base, identity, STATE, min(EVALUATE_SECONDS, max(0.1, deadline - loop.time())))
                if state[:2] == ['complete', 'loaded']:
                    break
                await asyncio.sleep(SETTLE_POLL)
        except ArtifactError as exc:
            log.info('Renderer settle ended early: %s', exc.detail)
        await asyncio.sleep(SETTLE_PAUSE)

    @staticmethod
    def address(values, allowed):
        """The tab address, which must lie under the authorized prefix; an unreadable address refuses (fail closed)."""
        href = values[0] if values else None
        if not isinstance(href, str):
            raise ArtifactError(422, 'render_blocked', 'The page address could not be verified')
        if not href.startswith(allowed):
            raise ArtifactError(422, 'render_blocked', 'The page left the artifact, so the screenshot was refused')

    async def render(self, user_id, view_path, width, height, full_page, clip=None):
        """Render `<artifact_render_base_url><view_path>`; `clip=(x, y, w, h)` crops full-page pixels with Pillow.

        The tab must still be under the minted view token or live preview id after settling and after the screenshot:
        a page that navigates the renderer elsewhere (or is redirected) is refused with `render_blocked`."""
        guard = GUARD.match(view_path)
        if guard is None:
            raise ArtifactError(422, 'render_blocked', 'Only artifact view and live preview pages can be rendered')
        base_url = self.p.settings.artifact_render_base_url.rstrip('/')
        allowed = base_url + guard.group(0)
        target = view_path + (('&' if '?' in view_path else '?') + RENDER_QUERY + '=1' if view_path.startswith('/artifact-live/') else '')
        lock = await self.acquire(user_id)
        identity = f'artifact-render:{uuid.uuid4()}'
        try:
            tab = await self._call('POST', '/tabs', {'userId': identity, 'sessionKey': 'artifact'})
            tab_id = tab.get('tabId')
            if not isinstance(tab_id, str) or not tab_id:
                raise unavailable('The screenshot service returned no tab')
            base = '/tabs/' + quote(tab_id, safe='')
            await self._call('POST', base + '/viewport', {'userId': identity, 'width': width, 'height': height})
            await self._call('POST', base + '/navigate', {'userId': identity, 'sessionKey': 'artifact', 'url': base_url + target})
            await self.settle(base, identity)
            try:
                page = await self.evaluate(base, identity, PAGE_INFO, 15)
            except ArtifactError as exc:
                raise ArtifactError(422, 'render_blocked', 'The page address could not be verified') from exc
            self.address(page, allowed)
            try:
                page_width, page_height = max(1, int(page[1])), max(1, int(page[2]))
                entries = [clean_console(item) for item in page[3]][:50]
            except (TypeError, ValueError, IndexError, OverflowError):
                page_width, page_height, entries = width, height, []
            params = {'userId': identity, 'fullPage': 'true' if full_page or clip else 'false'}
            if full_page or clip:
                # Native clip bounds the work to what is needed: eight screens for a view, down to the rect for a capture.
                needed = math.ceil(clip[1] + clip[3]) if clip else height * MAX_SEGMENTS
                params.update(clipX=0, clipY=0, clipWidth=max(width, min(page_width, MAX_CLIP_WIDTH)), clipHeight=max(1, min(page_height, needed)))
            image = await self._call('GET', base + '/screenshot', params=params, binary=True)
            try:
                self.address(await self.evaluate(base, identity, LOCATION), allowed)
            except ArtifactError as exc:
                if exc.code == 'render_blocked':
                    raise
                raise ArtifactError(422, 'render_blocked', 'The page address could not be verified') from exc
        finally:
            try:
                await asyncio.shield(self._forget(identity))
            finally:
                self.slots.release()
                lock.release()
        if clip is not None:
            image = await asyncio.to_thread(crop, image, clip)
        return Render(image, page_width, page_height, entries)


def crop(png, clip):
    """PNG bytes of the clipped full-page rectangle, clamped to the screenshot; an empty rectangle is `capture_invalid`."""
    try:
        with Image.open(io.BytesIO(png)) as image:
            if image.width * image.height > MAX_PIXELS:
                raise ArtifactError(413, 'render_too_large', 'The screenshot is too large to process')
            x, y, w, h = clip
            box = (max(0, math.floor(x)), max(0, math.floor(y)), min(image.width, math.ceil(x + w)), min(image.height, math.ceil(y + h)))
            if box[2] <= box[0] or box[3] <= box[1]:
                raise ArtifactError(422, 'capture_invalid', 'The selected region is outside the page')
            out = io.BytesIO()
            image.crop(box).save(out, 'PNG')
            return out.getvalue()
    except (OSError, Image.DecompressionBombError) as exc:
        raise ArtifactError(413, 'render_too_large', 'The screenshot could not be decoded') from exc


def segments(png, height, full_page):
    """`(jpeg bytes list, truncated)`: viewport-height segments of a full page, at most 8, each at most 1280 px wide."""
    try:
        with Image.open(io.BytesIO(png)) as source:
            image = source
            if image.width * image.height > MAX_PIXELS:
                raise ArtifactError(413, 'render_too_large', 'The screenshot is too large to process')
            image.load()
            count = math.ceil(image.height / height) if full_page else 1
            result = []
            for index in range(min(count, MAX_SEGMENTS)):
                part = image.crop((0, index * height, image.width, min(image.height, (index + 1) * height))) if full_page else image
                if part.mode in ('RGBA', 'LA', 'P'):
                    flat = Image.new('RGB', part.size, 'white')
                    flat.paste(part.convert('RGBA'), mask=part.convert('RGBA').split()[-1])
                    part = flat
                else:
                    part = part.convert('RGB')
                if part.width > MAX_IMAGE_WIDTH:
                    part = part.resize((MAX_IMAGE_WIDTH, max(1, round(part.height * MAX_IMAGE_WIDTH / part.width))), Image.LANCZOS)
                out = io.BytesIO()
                part.save(out, 'JPEG', quality=JPEG_QUALITY)
                result.append(out.getvalue())
            return result, count > MAX_SEGMENTS
    except (OSError, Image.DecompressionBombError) as exc:
        raise ArtifactError(413, 'render_too_large', 'The screenshot could not be decoded') from exc
