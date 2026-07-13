/* =====================================================================
   Knowledge data/actions (Phase 4b).

   Thin thunks over api() + endpoints that dispatch the knowledge slice's
   SET_* actions, mirroring the legacy loadDocuments / create / search / clear /
   doc-view handlers (legacy-app.js:1244-1304, 3186-3190). API paths, methods,
   and body shapes are preserved byte-for-byte. The async thunks are wrapped in
   runBusy by their callers (the legacy withBusy lifecycle + global busy flag).
   ===================================================================== */

import { api } from "../lib/api";
import { endpoints } from "../lib/endpoints";
import type {
  CreateDocumentRequest,
  DocumentResponse,
  Id,
  KnowledgeSearchResponse,
} from "../types";
import { loadDocuments, type AppStore } from "./loaders";

const documentRequestGenerations = new WeakMap<AppStore, number>();
const searchRequestGenerations = new WeakMap<AppStore, number>();

/* loadDocuments (GET list + reset search) is owned by the shared loaders module:
   the sidebar nav-in and the post-create reload must use the exact same
   implementation. Re-exported here so the knowledge view imports its whole data
   surface from one place. */
export { loadDocuments };

/** The by-id GET route is numeric-only server-side
 *  (`/api/knowledge/documents/(\d+)`), so a Cognee search hit whose id is not a
 *  local numeric row id must never call it (spec §6/§7). */
export function isNumericDocumentId(id: Id): boolean {
  return /^\d+$/.test(String(id));
}

/** POST a new knowledge document. The four keys are sent verbatim
 *  (title/source/summary/content); the server response is intentionally ignored
 *  — a subsequent loadDocuments() is the source of truth (legacy-app.js:1273). */
export async function createDocument(payload: CreateDocumentRequest): Promise<void> {
  await api(endpoints.createKnowledgeDocument.path(), {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** GET /api/knowledge/search?q=… and commit the results (legacy-app.js:1300-1303).
 *  Kept separate from the full library so a search never shrinks it permanently. */
export async function searchKnowledge(store: AppStore, query: string): Promise<void> {
  const generation = (searchRequestGenerations.get(store) || 0) + 1;
  searchRequestGenerations.set(store, generation);
  const ownerId = store.getState().user?.id;
  const result = await api<KnowledgeSearchResponse>(endpoints.knowledgeSearch.path(query));
  if (generation !== searchRequestGenerations.get(store)) return;
  if (String(store.getState().user?.id ?? "") !== String(ownerId ?? "")) return;
  store.dispatch({
    type: "SET_KNOWLEDGE_SEARCH",
    payload: { query, results: result.results || [] },
  });
}

/** Reset the committed search back to the full library (legacy clearSearch,
 *  legacy-app.js:1260-1263). Synchronous: no API call, no busy lifecycle. */
export function clearSearch(store: AppStore): void {
  searchRequestGenerations.set(store, (searchRequestGenerations.get(store) || 0) + 1);
  store.dispatch({ type: "SET_KNOWLEDGE_SEARCH", payload: { query: "", results: null } });
}

/** GET the full document by id and select it for the inline viewer
 *  (legacy doc-card "查看正文", legacy-app.js:1244-1249). No-ops on a non-numeric
 *  id so a Cognee hit cannot hit the numeric-only route. */
export async function openDocument(store: AppStore, id: Id): Promise<void> {
  if (!isNumericDocumentId(id)) return;
  const generation = (documentRequestGenerations.get(store) || 0) + 1;
  documentRequestGenerations.set(store, generation);
  const ownerId = store.getState().user?.id;
  const result = await api<DocumentResponse>(endpoints.knowledgeDocument.path(id));
  if (generation !== documentRequestGenerations.get(store)) return;
  if (String(store.getState().user?.id ?? "") !== String(ownerId ?? "")) return;
  store.dispatch({ type: "SET_SELECTED_DOCUMENT", payload: result.document });
}
