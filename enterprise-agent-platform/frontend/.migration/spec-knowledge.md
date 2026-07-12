# Migration Spec — Knowledge Base + Document Viewer

Source of truth: `frontend/src/legacy-app.js`
- `renderKnowledge()` — lines 1226–1329
- `renderDocViewer()` — lines 1331–1339
- `loadDocuments()` — lines 3186–3190
- Helpers used: `h` (117), `icon` (196), `field` (331), `cardHead` (334), `emptyState` (358), `hasPermission`/`isAdmin` (352–356), `withBusy` (3466), `api` (73), `toast` (247), `render` (268), `navItem` (489), `topbarInfo` (561), `renderContent` (573).
- Knowledge data also surfaces in chat via `renderMessage()` knowledge suggestion chips (lines 871–895) — out of scope but documented under "Cross-section coupling".

Backend contract (verified against `enterprise_agent_platform/server.py` 425–440 and `service.py` 2482–2622, `knowledge.py` 39–206) is captured per endpoint so payloads/field names are preserved verbatim.

Styles: `styles.css` — `.kb-grid`/`.kb-grid--single` (1005–1006), `.search-field*` (1007–1010), `.list__note` (1011), `.doc-card*` (1012–1026), `.doc-viewer*` (1027–1035), `.list` (1001), `.empty*` (1703–1722), `.panel`/`.panel__inner` (893–894), `.card`/`.card form` (983–999), `.field` (303–305), `.status` (1445), `.chip`/`.chip__id` (650–661).

---

## 0. IMPORTANT clarifications vs. the assignment brief

- **There is NO file upload, drag/drop, or paste handling in the knowledge view.** The "新增条目" (Add entry) card is a **plain structured text form** (title / source / summary / content textarea). The `upload` icon exists in the icon set but is NOT used here. "Upload" in this section = the create-document form POST. Do not build a file dropzone.
- **There is NO document delete in the UI.** The backend `KnowledgeBase.delete_document()` exists (`knowledge.py` 127) but there is **no frontend route, button, or `DELETE /api/knowledge/documents/{id}` call** anywhere in `legacy-app.js`. Do not invent a delete button — preserve current behavior (read + create only). (If delete is later desired it is a NEW feature, not a migration item.)
- The doc list and search results carry **different field sets** than the single-document fetch (see §6). The list/search payloads do **not** include `content`; only the by-id GET returns `content`. This is why the viewer always re-fetches by id.

---

## 1. View entry / data loading

### Navigation trigger (`navItem`, lines 489–502)
Clicking the sidebar "知识库" nav button runs:
```
state.activeView = "knowledge";
state.sidebarOpen = false;
await withBusy(loadDocuments);   // line 497
```
`withBusy` (3466–3480): sets `state.busy=true`, clears `state.error`, `render()`, runs the fn, on error sets `state.error` + toast (only if logged in), finally `state.busy=false`, `render()`.

### `loadDocuments()` (lines 3186–3190)
```
GET /api/knowledge/documents
-> { documents: [ ... ] }
state.documents = result.documents;
state.knowledgeSearch = { query: "", results: null };   // resets any active search on (re)load
```
Note: every `loadDocuments` (nav-in AND post-create) **clears the active search**.

### Topbar (`topbarInfo`, line 566)
When `activeView === "knowledge"`: `{ title: "知识库", icon: "library", sub: \`${state.documents.length} 篇文档\` }`. The doc count is read live from `state.documents.length` (NOT the search result count).

### No polling / no SSE for knowledge
`loadDocuments` runs only on nav-in and after a successful create. There is no interval, SSE, or `requestAnimationFrame` work tied to knowledge. (Global render plumbing's `afterRender`/`syncScopeStream` runs but does nothing for this view.)

---

## 2. Global `state` fields read/written by this section

| Field | Init | Read by | Written by |
|---|---|---|---|
| `state.documents` | `[]` | renderKnowledge (list, count), topbarInfo | `loadDocuments` (set to `result.documents`) |
| `state.knowledgeSearch` | `{ query: "", results: null }` | renderKnowledge (`query`, `results`, `isSearching`) | search submit (`{query, results}`), `clearSearch` (`{query:"", results:null}`), `loadDocuments` (reset) |
| `state.selectedDocument` | `null` | renderKnowledge (renders viewer if truthy), renderDocViewer (`.title`, `.content`) | doc-card "查看正文" (set to fetched `result.document`), viewer close button (set `null`) |
| `state.busy` | `false` | create submit button `disabled`; withBusy lifecycle | `withBusy` |
| `state.error` | `""` | (surfaced globally via toast in withBusy) | `withBusy` |
| `state.user` / permissions | — | `hasPermission("manage_knowledge")` gating | — |

`isSearching` is a **derived** value (not stored): `!!searchQuery && Array.isArray(searchResults)` (line 1234).

---

## 3. `renderKnowledge()` — markup tree (lines 1226–1329)

```
div.panel
  div.panel__inner
    div.kb-grid (or "kb-grid kb-grid--single" when !canManage)
      [section.card  "新增条目"]          // ONLY if canManage === hasPermission("manage_knowledge")
      section.card   "条目库"             // always
```

### 3a. Create card — `section.card` "新增条目" (lines 1267–1289, gated by `canManage`)
```
section.card
  cardHead("新增条目","plus",{desc:"结构化录入知识，供 Agent 检索引用。"})
    div.card__head > div > (div.card__title[icon(plus)+span] + div.card__desc) + null
  form (onsubmit -> create)
    field("标题",   input  placeholder="标题")
    field("来源",   input  placeholder="来源（URL、系统名等）")
    field("摘要",   input  placeholder="摘要（可留空）")
    field("正文",   textarea placeholder="正文内容…")
    button.btn.btn--primary[type=submit, disabled=state.busy]
      icon(plus,16) + span "保存条目"
```
`field(label,control)` = `label.field > span(label) + control` (line 331).
The four input/textarea nodes are created once at top of `renderKnowledge` (lines 1228–1231) as detached DOM elements and referenced directly in the submit handler via `.value` (uncontrolled).

### 3b. Library card — `section.card` "条目库" (lines 1291–1322, always shown)
```
section.card
  cardHead("条目库","library",{ extra: span.status text=`${state.documents.length} docs` })
  form (onsubmit -> search)
    div.search-field
      icon(search)
      input  placeholder="搜索标题或正文…"  aria-label="搜索知识库"  value=searchQuery
      [button.icon-btn.search-field__clear  type=button  title="清除搜索"
         aria-label="清除搜索，显示全部条目"  onclick=clearSearch  -> icon(close,15)]   // only when isSearching
  [div.list__note]                          // only when isSearching
      span text=`搜索“${searchQuery}”：${searchResults.length} 条结果`
      button.btn.btn--sm[type=button] "显示全部"  onclick=clearSearch
  div.list  -> docCards
  [renderDocViewer()]                        // only when state.selectedDocument truthy
```

### 3c. `docCard(doc)` (lines 1237–1252) — one entry in `.list`
```
div.doc-card
  div.doc-card__title  [ icon(doc) , span text=doc.title ]
  [div.doc-card__summary text=doc.summary]      // only if doc.summary truthy
  div.doc-card__actions
    button.btn.btn--sm  onclick=async(view content)
      icon(doc,14) + span "查看正文"
```

### 3d. List source + empty states (lines 1254–1258)
```
listSource = isSearching ? searchResults : state.documents
emptyCard  = isSearching
  ? emptyState("search","没有匹配结果",`未找到与“${searchQuery}”相关的条目。`)
  : emptyState("doc","知识库为空","在左侧表单中录入第一条知识。")
docCards   = listSource.length ? listSource.map(docCard) : [emptyCard]
```
`emptyState(icon,title,text)` = `div.empty > div.empty__icon[icon(size26)] + h3(title) + p(text)` (line 358).

---

## 4. Event handlers (exhaustive)

### H1 — Create form `onsubmit` (lines 1270–1281), present only when `canManage`
1. `event.preventDefault()`
2. `withBusy(async)`:
   - `POST /api/knowledge/documents` with body `JSON.stringify({ title: title.value, source: source.value, summary: summary.value, content: content.value })`
   - On success: clear all four inputs (`title.value = source.value = summary.value = content.value = ""`), then `await loadDocuments()` (refreshes list + clears search), then `toast("已保存知识条目", { type: "ok", title: "完成" })`.
   - Response body is **ignored** by the client (reload is the source of truth).
   - No client validation; empty title/content are sent and the server rejects with 400 (`"title is required"` / `"content is required"`) → withBusy surfaces an error toast.

### H2 — Search form `onsubmit` (lines 1294–1304)
1. `event.preventDefault()`
2. `query = search.value.trim()`
3. If `!query`: call `clearSearch()` and return (no API call).
4. Else `withBusy(async)`:
   - `GET /api/knowledge/search?q=${encodeURIComponent(query)}`
   - `state.knowledgeSearch = { query, results: result.results || [] }`
   - (No toast on success; results render inline.)

### H3 — `clearSearch()` (lines 1260–1263)
`state.knowledgeSearch = { query: "", results: null }; render();` — used by the inline clear (X) button, the "显示全部" buttons (in `.search-field__clear` and `.list__note`), and the empty-query search submit.

### H4 — doc-card "查看正文" `onclick` (lines 1244–1249)
`withBusy(async)`:
- `GET /api/knowledge/documents/${doc.id}` → `{ document: {...} }`
- `state.selectedDocument = result.document`
- (withBusy re-renders; the viewer appears at the bottom of the library card.)

### H5 — viewer close `onclick` (line 1335)
`state.selectedDocument = null; render();`

No `input`, `keydown`, `paste`, `focus`, `blur`, `drag`, or `drop` handlers exist in this section. Inputs are uncontrolled; `oninput` is absent (so typing does not trigger re-render).

---

## 5. `renderDocViewer()` (lines 1331–1339)
```
div.doc-viewer
  div.doc-viewer__bar
    span.eyebrow text = state.selectedDocument.title || "DOCUMENT"
    button.icon-btn  title="关闭"  aria-label="关闭文档"  onclick=close -> icon(close,16)
  pre  text = state.selectedDocument.content
```
`.doc-viewer pre`: `white-space: pre-wrap; word-break: break-word; max-height: 360px; overflow:auto`. Content is rendered as **plain text** (`textContent`), never HTML — no markdown/sanitization needed but DO keep it text-only.

---

## 6. API contract (verbatim — preserve paths, methods, field names)

### GET `/api/knowledge/documents`  (load list)
- Permission: `read_workspace`.
- Response: `{ "documents": Document[] }` ordered `updated_at DESC, id DESC`, **limit 50** (server default, no client paging).
- `Document` (list shape, NO `content`): `{ id:int, title:string, summary:string, source:string, created_by:int|null, created_at:int, updated_at:int }`.

### POST `/api/knowledge/documents`  (create)
- Permission: `manage_knowledge`.
- Request body (exact keys): `{ title, source, summary, content }` (all strings; `summary` may be empty → server auto-summarizes; `source` optional).
- Response: HTTP **201** `{ "document": { id, title, summary, content, source, created_by, created_at, updated_at, cognee:{...} } }`. **Client ignores the response.**
- Server dedups on `(title, content, source)` — identical re-submit returns the existing row, `created:false`, `cognee.deduplicated:true`. Cognee ingestion is queued async server-side; irrelevant to the client.

### GET `/api/knowledge/search?q=<query>`  (search)
- Permission: `read_workspace`.
- Query param `q` (URL-encoded). Server also accepts `limit` (default 5, clamped 1–20) — **the client never sends `limit`**, so default 5 applies.
- Response: `{ "results": Hit[] }`.
- `Hit` (NO `content`): `{ id:int, title:string, summary:string, source:string, score:float }`.
- Results may merge local FTS hits + Cognee graph hits depending on backend `mode`. Cognee hits share the `Hit` shape but their `id` may not be a numeric local document row id (see Edge cases).

### GET `/api/knowledge/documents/{id}`  (view full doc)
- Route regex server-side: `/api/knowledge/documents/(\d+)` — **numeric ids only**.
- Permission: `read_workspace`.
- Response: `{ "document": { id, title, summary, content, source, created_by, created_at, updated_at } }` (full shape WITH `content`).
- 404 `{error/detail: "knowledge document not found"}` if id absent.

(`GET /api/knowledge/status` exists server-side but is NOT called by the knowledge UI.)

---

## 7. Edge cases / gating / states

- **Permission gating**: `canManage = hasPermission("manage_knowledge")` (admin OR has the permission). When false: create card is omitted and the grid switches to `.kb-grid--single`. The library card (read + search + view) is always present (assumes `read_workspace`; non-`read_workspace` users would 401 on load → `handleSessionExpired`/error toast). `hasPermission` returns true for admins regardless of explicit permission.
- **Empty list (not searching)**: shows `emptyState("doc","知识库为空","在左侧表单中录入第一条知识。")`.
- **Empty search results**: shows `emptyState("search","没有匹配结果", …query…)`. The `.list__note` still shows `…：0 条结果` + "显示全部".
- **Loading state**: there is NO skeleton/spinner in the view. During `withBusy`, only the create submit button is `disabled`. Because `state.documents` starts `[]`, the FIRST nav-in renders the "知识库为空" empty card for one frame before data arrives → visible flash. (Migration opportunity: gate on a loading flag.)
- **Search-input value flash (existing quirk)**: the search input is uncontrolled with `value=searchQuery` set per render. On submit, `withBusy` re-renders with `busy=true` BEFORE `state.knowledgeSearch.query` is updated, so the input momentarily reverts to the previous query (empty on first search) and then snaps to the new query once the request resolves. Reproduce-or-fix decision belongs to the React port (see §9).
- **Cognee hit "查看正文" can 404**: a search Hit originating from Cognee may carry an id that is non-numeric or not a local row; `GET /api/knowledge/documents/{id}` then 404s (or doesn't match the numeric route) and surfaces an error toast via `withBusy`. Existing behavior — keep, but consider hiding/disabling the view button for hits whose id is non-numeric.
- **selectedDocument persistence**: the viewer stays open across searches and library reloads as long as `state.selectedDocument` is set; it is only cleared by the close button or by setting another doc. `loadDocuments` does NOT clear it. (Logout/session-expiry don't clear it either, but the whole shell unmounts.)
- **Error handling**: all failures route through `withBusy` → `state.error` + a toast `{type:"error", title:"操作失败"}` (only when `state.user` is set). 401 anywhere triggers `handleSessionExpired()` inside `api()`.
- **XSS**: all text uses `textContent` via `h(...,{text})`; the viewer `<pre>` is text-only. No `innerHTML`. Preserve this — render `content`/`title`/`summary` as text, never `dangerouslySetInnerHTML`.

---

## 8. Accessibility — present & gaps

Present:
- Search input: `aria-label="搜索知识库"`.
- Clear (X) button: `title="清除搜索"`, `aria-label="清除搜索，显示全部条目"`.
- Viewer close button: `title="关闭"`, `aria-label="关闭文档"`.
- Icons rendered via `icon()` carry `aria-hidden="true"`.
- Toasts use `role="status"` (in `toast()`).

Gaps to fix in React:
- The doc viewer panel has **no `role`/`aria-modal`/focus management** — opening it does NOT move focus, and closing does NOT restore focus to the triggering "查看正文" button (full-teardown render discards focus). It is an inline panel, not a modal; at minimum, on open move focus to the viewer (or its close button) and on close return focus to the originating doc-card button.
- "查看正文" buttons lack any `aria-expanded`/linkage to the viewer they control.
- The `.list` is a plain `div` (no `role="list"`/`listitem`); doc cards are not semantically a list.
- Empty/loading states are not announced to AT (no `aria-live`).
- No keyboard affordance distinct from buttons; cards themselves aren't focusable (fine — actions are buttons).

---

## 9. React 19 migration plan

### Proposed component tree
```
<KnowledgeView/>                         // route view; owns data fetching + search/selection state
  <KnowledgeCreateCard/>                 // rendered only if canManage
  <KnowledgeLibraryCard/>
     <KnowledgeSearchForm/>
     <SearchResultNote/>                 // when searching
     <DocumentList/>                     // maps docs -> <DocumentCard/>, or <EmptyState/>
        <DocumentCard/>                  // per item; "查看正文" button
     <DocumentViewer/>                   // when a doc is selected (inline panel)
  <EmptyState/>                          // shared (icon/title/text), reused across app
```

### State ownership (lift to `<KnowledgeView/>`, or a `useKnowledge()` hook / context slice)
- `documents: Document[]`, `loading: boolean`, `error: string`.
- `search: { query: string; results: Hit[] | null }` (mirror `state.knowledgeSearch`). `isSearching = !!query && results !== null` via `useMemo`.
- `selectedDocument: FullDocument | null` + `selectedDocLoading`.
- Derive `canManage` from an auth/permissions context (`hasPermission("manage_knowledge")`), not local state.

### Hooks / data fetching
- Fetch list on mount (and expose `reload()`); replicate `loadDocuments`: GET list, set `documents`, reset `search`. Use `useEffect` + an abort guard, or React Query / SWR keyed by `["knowledge","documents"]`.
- Search: keep the input **controlled** with local component state (`inputValue`) separate from the committed `search.query`. On submit, set `search` and call the search endpoint. This cleanly eliminates the value-flash quirk (§7) — do NOT re-derive the input value from `search.query` during the in-flight render.
- View doc: on "查看正文" click, fetch by id (numeric guard) and set `selectedDocument`; show a per-card pending state instead of a global busy if desired.
- Create: controlled form (`useState` per field or one object); on submit POST, then `reload()` + success toast, then clear fields. Disable submit while pending.

### Endpoint constants (preserve EXACTLY)
```ts
GET    /api/knowledge/documents
POST   /api/knowledge/documents              body: { title, source, summary, content }
GET    /api/knowledge/search?q={encodeURIComponent(query)}
GET    /api/knowledge/documents/{id}         // numeric id only
```
Keep `credentials:"include"`, JSON `Content-Type`, and the `api()` 401→session-expired + `error||detail||"请求失败（{status}）"` error contract.

### Reconciliation / focus / scroll concerns moving off full-teardown
- **Search input identity**: render the search `<input>` with a stable key so React preserves the DOM node and caret across re-renders (no teardown means typing no longer needs the deferred-render hack). Caret position will be naturally preserved when controlled.
- **Doc viewer focus**: implement proper focus handoff (focus viewer/close on open, restore to the triggering card button on close) — this was impossible under full teardown and is the main a11y win.
- **List scroll**: `.panel` is the scroll container; with diffing, list updates after search/clear won't reset scroll the way `replaceChildren` did. Verify search→clear returns the user to a sensible scroll position (acceptable to keep top).
- **No global busy churn**: replace the `withBusy` full re-render with localized loading flags (create-pending, search-pending, doc-pending) so unrelated parts of the view don't flash. Keep the global error→toast behavior.
- **selectedDocument lifecycle**: clear it on unmount/logout; decide whether `reload()` after create should also close the viewer (legacy keeps it open — preserve unless product says otherwise).

### Type definitions to add
```ts
interface DocumentListItem { id:number; title:string; summary:string; source:string; created_by:number|null; created_at:number; updated_at:number }
interface FullDocument extends DocumentListItem { content:string }
interface KnowledgeHit { id:number|string; title:string; summary:string; source:string; score:number }
```

---

## 10. Cross-section coupling (informational, not in scope)

Knowledge data also appears in **chat messages** (`renderMessage`, lines 871–895): `message.metadata.knowledge_suggestions` is an array of `KnowledgeHit`-shaped objects rendered as chips `kb:{s.id}` + `s.title` inside `.msg__suggest > .chip`. The chips are display-only (no link to open the doc). Server populates this via `service.py` ~1941 (`"knowledge_suggestions": [h.to_dict() ...]`). The chat section owns this; the knowledge migration only needs to keep the `KnowledgeHit` type compatible.
