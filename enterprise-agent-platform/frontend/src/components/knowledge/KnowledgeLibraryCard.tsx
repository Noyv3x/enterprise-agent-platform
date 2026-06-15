/* <KnowledgeLibraryCard/> — the "条目库" card (legacy-app.js:1291-1322): search
   form, the search-result note, the document list, and the inline viewer. Owns
   the doc-view trigger reference so closing the viewer restores focus to the
   exact "查看正文" button that opened it (the focus handoff on close). */

import { useMemo, useRef } from "react";
import { clearSearch, openDocument } from "../../data/knowledgeActions";
import { runBusy } from "../../data/sessionActions";
import { useStore, useStoreHandle } from "../../store/useStore";
import type { Id } from "../../types";
import { CardHead } from "../common/CardHead";
import { DocumentList } from "./DocumentList";
import { DocumentViewer } from "./DocumentViewer";
import { KnowledgeSearchForm } from "./KnowledgeSearchForm";

export function KnowledgeLibraryCard() {
  const store = useStoreHandle();
  const documents = useStore((state) => state.documents);
  const search = useStore((state) => state.knowledgeSearch);
  const selectedDocument = useStore((state) => state.selectedDocument);
  const busy = useStore((state) => state.busy);

  // The button that opened the current viewer, so we can return focus to it on
  // close (an inline panel, not a modal).
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const isSearching = useMemo(
    () => !!search.query && Array.isArray(search.results),
    [search.query, search.results],
  );
  const results = search.results;
  const items = isSearching ? results ?? [] : documents;
  // Loading only for the very first library load (avoids the legacy empty flash);
  // a search keeps the prior list visible while it resolves.
  const loading = busy && !isSearching && documents.length === 0;

  const handleView = (id: Id, button: HTMLButtonElement) => {
    triggerRef.current = button;
    void runBusy(store, () => openDocument(store, id));
  };

  const handleCloseViewer = () => {
    store.dispatch({ type: "SET_SELECTED_DOCUMENT", payload: null });
    // Move focus back to the originating trigger before React commits the
    // viewer unmount, so focus never falls to <body>.
    triggerRef.current?.focus();
  };

  return (
    <section className="card">
      <CardHead
        title="条目库"
        icon="library"
        extra={<span className="status">{`${documents.length} docs`}</span>}
      />
      <KnowledgeSearchForm />
      {isSearching ? (
        <div className="list__note">
          <span>{`搜索“${search.query}”：${(results ?? []).length} 条结果`}</span>
          <button className="btn btn--sm" type="button" onClick={() => clearSearch(store)}>
            <span>显示全部</span>
          </button>
        </div>
      ) : null}
      <DocumentList
        items={items}
        isSearching={isSearching}
        searchQuery={search.query}
        loading={loading}
        selectedId={selectedDocument?.id}
        onView={handleView}
      />
      {selectedDocument ? (
        <DocumentViewer document={selectedDocument} onClose={handleCloseViewer} />
      ) : null}
    </section>
  );
}
