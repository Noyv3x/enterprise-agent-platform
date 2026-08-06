/* Knowledge data and actions. Thin thunks over api() and endpoints dispatch the
   knowledge slice's SET_* actions. Callers wrap asynchronous operations in
   runBusy. */

import { api, apiUpload, type ApiUploadProgress } from "../lib/api";
import { endpoints } from "../lib/endpoints";
import type {
  CreateDocumentRequest,
  DocumentResponse,
  KnowledgeImportResponse,
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

/** POST a new knowledge document. The four keys are sent verbatim
 *  (title/source/summary/content); the server response is intentionally ignored
 *  — a subsequent loadDocuments() is the source of truth. */
export async function createDocument(payload: CreateDocumentRequest): Promise<void> {
  await api(endpoints.createKnowledgeDocument.path(), {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function importKnowledgeDocuments(
  files: readonly File[],
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: ApiUploadProgress) => void;
  } = {},
): Promise<KnowledgeImportResponse> {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  return apiUpload<KnowledgeImportResponse>(endpoints.importKnowledgeDocuments.path(), form, options);
}

/** GET /api/knowledge/search?q=… and commit results separately from the full library. */
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

/** Reset the committed search to the full library without an API call. */
export function clearSearch(store: AppStore): void {
  searchRequestGenerations.set(store, (searchRequestGenerations.get(store) || 0) + 1);
  store.dispatch({ type: "SET_KNOWLEDGE_SEARCH", payload: { query: "", results: null } });
}

/** GET the authoritative document by its stable numeric id and select it for the viewer. */
export async function openDocument(store: AppStore, id: number): Promise<void> {
  const generation = (documentRequestGenerations.get(store) || 0) + 1;
  documentRequestGenerations.set(store, generation);
  const ownerId = store.getState().user?.id;
  const result = await api<DocumentResponse>(endpoints.knowledgeDocument.path(id));
  if (generation !== documentRequestGenerations.get(store)) return;
  if (String(store.getState().user?.id ?? "") !== String(ownerId ?? "")) return;
  store.dispatch({ type: "SET_SELECTED_DOCUMENT", payload: result.document });
}
