/* <DocumentList/> — the list of document cards, or an empty/loading state. The list source
   is search results when searching, else the full library. A loading state is
   shown only for the initial library load; search keeps the prior list visible. */

import { List, Spin } from "antd";
import type { ReactNode } from "react";
import { useI18n } from "../../i18n";
import type { Id, KnowledgeDocument, KnowledgeHit } from "../../types";
import { EmptyState } from "../common/EmptyState";
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
      <div className="knowledge-list__loading" role="status">
        <Spin size="large" />
        <p>{t("knowledge.loading")}</p>
      </div>
    );
  } else if (items.length) {
    body = (
      <List
        className="knowledge-list"
        split={false}
        dataSource={[...items]}
        renderItem={(doc) => (
          <List.Item className="knowledge-list__item" key={String(doc.id)}>
            <DocumentCard
              doc={doc}
              selected={selectedId != null && String(selectedId) === String(doc.id)}
              onView={onView}
            />
          </List.Item>
        )}
      />
    );
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
  return <div className="knowledge-list-region">{body}</div>;
}
