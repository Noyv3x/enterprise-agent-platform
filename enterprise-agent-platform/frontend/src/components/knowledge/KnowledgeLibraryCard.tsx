/* <KnowledgeLibraryCard/> — the "条目库" card (legacy-app.js:1291-1322): search
   form, the search-result note, the document list, and the inline viewer. Owns
   the doc-view trigger reference so closing the viewer restores focus to the
   exact "查看正文" button that opened it (the focus handoff on close). */

import { Button, Card } from "antd";
import { useMemo, useRef, useState } from "react";
import { clearSearch, loadDocuments, openDocument } from "../../data/knowledgeActions";
import { resourceKeys, runResourceLoad } from "../../data/resourceState";
import { useI18n } from "../../i18n";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useStore, useStoreHandle } from "../../store/useStore";
import type { Id } from "../../types";
import { EmptyState } from "../common/EmptyState";
import { Drawer } from "../common/Drawer";
import { ResourceStatusView } from "../common/ResourceStatusView";
import { DocumentList } from "./DocumentList";
import { DocumentViewer } from "./DocumentViewer";
import { KnowledgeSearchForm } from "./KnowledgeSearchForm";

export function KnowledgeLibraryCard() {
  const { t } = useI18n();
  const isMobile = useMediaQuery("(max-width: 800px)");
  const store = useStoreHandle();
  const documents = useStore((state) => state.documents);
  const search = useStore((state) => state.knowledgeSearch);
  const selectedDocument = useStore((state) => state.selectedDocument);
  const [requestedId, setRequestedId] = useState<Id | null>(null);

  // The button that opened the current viewer, so we can return focus to it on
  // close (an inline panel, not a modal).
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const isSearching = useMemo(
    () => !!search.query && Array.isArray(search.results),
    [search.query, search.results],
  );
  const results = search.results;
  const items = isSearching ? results ?? [] : documents;
  const handleView = (id: Id, button: HTMLButtonElement) => {
    triggerRef.current = button;
    setRequestedId(id);
    void runResourceLoad(store, resourceKeys.knowledgeDocument(id), () => openDocument(store, id));
  };

  const handleCloseViewer = () => {
    store.dispatch({ type: "SET_SELECTED_DOCUMENT", payload: null });
    setRequestedId(null);
    // Move focus back to the originating trigger before React commits the
    // viewer unmount, so focus never falls to <body>.
    triggerRef.current?.focus();
  };

  return (
    <div className="knowledge-workspace">
      <section className="knowledge-browser-region" aria-label={t("knowledge.library")}>
        <Card
          className="knowledge-browser"
          classNames={{ body: "knowledge-browser__body" }}
          variant="outlined"
        >
          <KnowledgeSearchForm />
          <div className="knowledge-browser__content">
            {isSearching ? (
              <div className="list__note">
                <span>
                  {t("knowledge.searchResults", {
                    query: search.query,
                    count: (results ?? []).length,
                  })}
                </span>
                <Button size="small" onClick={() => clearSearch(store)}>
                  {t("knowledge.showAll")}
                </Button>
              </div>
            ) : null}
            <ResourceStatusView
              resourceKey={resourceKeys.knowledgeList}
              hasData={documents.length > 0}
              onRetry={() => void runResourceLoad(store, resourceKeys.knowledgeList, () => loadDocuments(store))}
            >
              <DocumentList
                items={items}
                isSearching={isSearching}
                searchQuery={search.query}
                loading={false}
                selectedId={requestedId ?? selectedDocument?.id}
                onView={handleView}
              />
            </ResourceStatusView>
          </div>
        </Card>
      </section>
      {!isMobile ? (
        <section className="knowledge-detail-region" aria-label={t("knowledge.documentRegion")}>
          <Card
            className="knowledge-detail"
            classNames={{ body: "knowledge-detail__body" }}
            variant="outlined"
          >
            {requestedId ? (
              <ResourceStatusView
                resourceKey={resourceKeys.knowledgeDocument(requestedId)}
                hasData={!!selectedDocument && String(selectedDocument.id) === String(requestedId)}
                onRetry={() => void runResourceLoad(store, resourceKeys.knowledgeDocument(requestedId), () => openDocument(store, requestedId))}
              >
                {selectedDocument && String(selectedDocument.id) === String(requestedId) ? (
                  <DocumentViewer document={selectedDocument} onClose={handleCloseViewer} />
                ) : null}
              </ResourceStatusView>
            ) : (
              <EmptyState
                icon="doc"
                title={t("knowledge.selectDocument")}
                text={t("knowledge.selectDocumentDetail")}
              />
            )}
          </Card>
        </section>
      ) : null}
      <Drawer
        open={isMobile && requestedId != null}
        onClose={handleCloseViewer}
        title={selectedDocument?.title || t("knowledge.documentRegion")}
        description={selectedDocument?.source || undefined}
      >
        {requestedId ? (
          <ResourceStatusView
            resourceKey={resourceKeys.knowledgeDocument(requestedId)}
            hasData={!!selectedDocument && String(selectedDocument.id) === String(requestedId)}
            onRetry={() => void runResourceLoad(store, resourceKeys.knowledgeDocument(requestedId), () => openDocument(store, requestedId))}
          >
            {selectedDocument && String(selectedDocument.id) === String(requestedId) ? (
              <DocumentViewer document={selectedDocument} onClose={handleCloseViewer} showClose={false} />
            ) : null}
          </ResourceStatusView>
        ) : null}
      </Drawer>
    </div>
  );
}
