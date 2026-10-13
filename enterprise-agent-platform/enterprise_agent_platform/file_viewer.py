"""The sandboxed Office viewer: its HTML shell, its headers and the static bundle route (platform-api.md § Office viewer).

DOCX, XLSX and PPTX are parsed by third-party JavaScript, so they only ever run inside an opaque-origin frame under a strict CSP:
the shell holds no document content, the libraries come from `/file-viewer/`, and the file arrives through its own `?raw=1` URL.
"""
from html import escape

from starlette.exceptions import HTTPException
from starlette.responses import FileResponse, Response
from starlette.routing import Route

OFFICE_KINDS = ('docx', 'xlsx', 'pptx')
RAW_QUERY = 'raw'
VIEWER_DIR = 'file-viewer'
VIEWER_ENTRY = 'viewer.js'
VIEW_CSP = ("sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads "
            "allow-presentation allow-pointer-lock; frame-ancestors 'self'")
VIEW_HEADERS = {'Content-Security-Policy': VIEW_CSP, 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
                'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'X-Frame-Options': 'SAMEORIGIN'}
VIEWER_CSP = ("sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src blob: data:; "
              "font-src blob: data:; media-src blob: data:; connect-src 'self' blob:; base-uri 'none'; form-action 'none'; "
              "frame-ancestors 'self'")
CORS = {'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin'}
SHELL_HEADERS = {'Content-Security-Policy': VIEWER_CSP, 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
                 'X-Frame-Options': 'SAMEORIGIN', 'Cache-Control': 'private, max-age=7200'}
STYLE = """
html,body{margin:0;min-height:100%;background:#f1f1f0;color:#1f1f1e;font:14px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif}
.eap-error{margin:24px;padding:16px;border-radius:8px;background:#fff;color:#8a1c1c;box-shadow:0 0 0 1px rgba(0,0,0,.08)}
html[data-eap-viewer=loading] #root:empty::before{content:"";display:block;margin:40vh auto 0;width:24px;height:24px;border-radius:50%;border:2px solid #c9c9c6;border-top-color:#555;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){html[data-eap-viewer=loading] #root:empty::before{animation:none}}
.docx-wrapper{background:#f1f1f0!important;padding:12px 0!important}
.docx-wrapper>section.docx{margin:0 auto 12px!important;box-shadow:0 0 0 1px rgba(0,0,0,.08),0 2px 8px rgba(0,0,0,.08)!important;max-width:100%}
/* No horizontal padding: the library sizes slides to the container's full width, so padding would overflow the viewport. */
.pptx-stage{padding:12px 0;box-sizing:border-box;width:100%;max-width:100%;display:flex;flex-direction:column;align-items:center;gap:12px}
.tabs{position:sticky;top:0;z-index:2;display:flex;gap:2px;overflow-x:auto;padding:6px 8px 0;background:#e6e6e4;box-shadow:0 1px 0 rgba(0,0,0,.1)}
.tabs button{flex:none;min-height:44px;padding:0 14px;border:0;border-radius:6px 6px 0 0;background:transparent;color:#4a4a48;font:inherit;cursor:pointer}
.tabs button[aria-selected=true]{background:#fff;color:#111;font-weight:600}
.sheet{padding:0 0 16px;background:#fff;overflow:auto}
.sheet table{border-collapse:collapse;font-size:13px;min-width:100%}
.sheet th,.sheet td{border:1px solid #d9d9d6;padding:2px 8px;max-width:420px;min-width:48px;white-space:pre-wrap;overflow-wrap:anywhere;vertical-align:top}
.sheet th{position:sticky;background:#f3f3f1;color:#6b6b68;font-weight:500;text-align:center}
.sheet thead th{top:0}
.sheet tbody th,.sheet thead th:first-child{left:0;width:1%;min-width:40px;white-space:nowrap}
.sheet thead th:first-child{z-index:1}
.sheet td.num{text-align:right;font-variant-numeric:tabular-nums}
.sheet td.merged{background:#fafaf8}
.sheet-name{margin:0;padding:8px 12px;font-size:14px;background:#e6e6e4}
.sheet .note{margin:8px 12px;color:#6b6b68}
"""


LANGUAGES = ('en', 'zh-CN', 'zh-TW')


def shell(kind, title, stacked=False, lang=None):
    """The viewer page for one Office file; `title` is the only dynamic text and is escaped. `stacked` (the self-check renderer)
    draws every sheet one below the other instead of tabs, so one screenshot shows the whole workbook."""
    language = lang if lang in LANGUAGES else 'en'
    layout = ' data-layout="stacked"' if stacked else ''
    page = (f'<!doctype html><html lang="{language}" data-eap-viewer="loading" data-kind="{escape(kind, quote=True)}"{layout}><head>'
            '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{escape(title)}</title><style>{STYLE}</style></head><body><div id="root"></div>'
            f'<script type="module" src="/{VIEWER_DIR}/{VIEWER_ENTRY}"></script></body></html>')
    return Response(page, media_type='text/html; charset=utf-8', headers=SHELL_HEADERS)


def wants_lang(request):
    return request.query_params.get('lang')


def wants_raw(request):
    return request.query_params.get(RAW_QUERY) == '1'


async def viewer_asset(request):
    """The built bundle, public and cacheable: it holds no secrets and is identical for every file."""
    root = (request.app.state.platform.settings.frontend_dir / VIEWER_DIR).resolve()
    relative = request.path_params['path']
    target = (root / relative).resolve()
    if not relative or not target.is_relative_to(root) or not target.is_file() or target.suffix != '.js':
        raise HTTPException(404, 'Not found')
    hashed = target.name != VIEWER_ENTRY
    headers = {**CORS, 'X-Content-Type-Options': 'nosniff', 'Vary': 'Accept-Encoding',
               'Cache-Control': 'public, max-age=31536000, immutable' if hashed else 'no-cache'}
    # The build writes Brotli and Gzip sidecars next to each script, like the app's own assets.
    accepted = {}
    for entry in request.headers.get('accept-encoding', '').split(','):
        name, _, quality = entry.strip().partition(';q=')
        try:
            accepted[name.strip()] = float(quality) if quality else 1.0
        except ValueError:
            accepted[name.strip()] = 0.0
    for encoding, suffix in (('br', '.br'), ('gzip', '.gz')):
        sidecar = target.with_name(target.name + suffix)
        if accepted.get(encoding, accepted.get('*', 0)) > 0 and sidecar.is_file():
            return FileResponse(sidecar, media_type='text/javascript; charset=utf-8', headers={**headers, 'Content-Encoding': encoding})
    return FileResponse(target, media_type='text/javascript; charset=utf-8', headers=headers)


def routes():
    return [Route(f'/{VIEWER_DIR}/{{path:path}}', viewer_asset)]
