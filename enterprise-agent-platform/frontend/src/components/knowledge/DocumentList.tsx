/* <DocumentList/> — the .list of doc cards, or an empty/loading state
   (legacy listSource/emptyCard, legacy-app.js:1254-1258, 1320). The list source
   is search results when searching, else the full library. A loading state is
   shown only for the initial library load (the legacy "知识库为空" flash that
   §7 flags as a migration opportunity); search keeps the prior list visible. */

import type { ReactNode } from "react";
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
  let body: ReactNode;
  if (loading) {
    body = (
      <div className="empty">
        <div className="empty__icon">
          <Spinner size={26} />
        </div>
        <p>加载中…</p>
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
        title="没有匹配结果"
        text={`未找到与“${searchQuery}”相关的条目。`}
      />
    );
  } else {
    body = <EmptyState icon="doc" title="知识库为空" text="在左侧表单中录入第一条企业知识。" />;
  }
  return <div className="list">{body}</div>;
}
