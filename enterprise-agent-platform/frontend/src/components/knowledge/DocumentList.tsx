/* <DocumentList/> — the .list of doc cards, or an empty/loading state
   (legacy listSource/emptyCard, legacy-app.js:1254-1258, 1320). The list source
   is search results when searching, else the full library. A loading state is
   shown only for the initial library load (the legacy "知识库为空" flash that
   §7 flags as a migration opportunity); search keeps the prior list visible. */

import type { ReactNode } from "react";
import { useI18n } from "../../i18n";
import type { Id, KnowledgeDocument, KnowledgeHit } from "../../types";
import { EmptyState } from "../common/EmptyState";
import { Spinner } from "../common/Spinner";
import { DocumentCard } from "./DocumentCard";

export interface DocumentListProps {
  items: ReadonlyArray<KnowledgeDocument | KnowledgeHit>;
  isSearching: boolean;
  searchQuery: string;
  loading: boolean;
  selectedId?: Id;
  onView: (id: Id, button: HTMLButtonElement) => void;
}

export function DocumentList({
  items,
  isSearching,
  searchQuery,
  loading,
  selectedId,
  onView,
}: DocumentListProps) {
  const { t } = useI18n();
  let body: ReactNode;
  if (loading) {
    body = (
      <div className="empty">
        <div className="empty__icon">
          <Spinner size={26} />
        </div>
        <p>{t("knowledge.loading")}</p>
      </div>
    );
  } else if (items.length) {
    body = items.map((doc) => (
      <DocumentCard
        key={String(doc.id)}
        doc={doc}
        selected={selectedId != null && String(selectedId) === String(doc.id)}
        onView={onView}
      />
    ));
  } else if (isSearching) {
    body = (
      <EmptyState
        icon="search"
        title={t("knowledge.noResults")}
        text={t("knowledge.noResultsDetail", { query: searchQuery })}
      />
    );
  } else {
    body = (
      <EmptyState
        icon="doc"
        title={t("knowledge.empty")}
        text={t("knowledge.emptyDetail")}
      />
    );
  }
  return <div className="list">{body}</div>;
}
