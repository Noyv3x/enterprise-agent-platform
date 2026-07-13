/* <DocumentCard/> — one entry in the .list (legacy docCard, legacy-app.js:1237-1252).
   "查看正文" fetches the full document by id. The button is disabled for hits
   whose id is non-numeric (Cognee graph hits): the by-id route is numeric-only,
   so calling it would 404 — disabling it is the documented improvement (spec §7). */

import { isNumericDocumentId } from "../../data/knowledgeActions";
import { useI18n } from "../../i18n";
import type { Id, KnowledgeDocument, KnowledgeHit } from "../../types";
import { formatTimestamp } from "../../utils/format";
import { Icon } from "../common/Icon";
import { DOC_VIEWER_ID } from "./DocumentViewer";

export interface DocumentCardProps {
  doc: KnowledgeDocument | KnowledgeHit;
  /** true when this card's document is the one currently open in the viewer. */
  selected: boolean;
  onView: (id: Id, button: HTMLButtonElement) => void;
}

export function DocumentCard({ doc, selected, onView }: DocumentCardProps) {
  const { t } = useI18n();
  const canView = isNumericDocumentId(doc.id);
  return (
    <div className="doc-card">
      <div className="doc-card__title">
        <Icon name="doc" />
        <span>{doc.title}</span>
      </div>
      {doc.summary ? <div className="doc-card__summary">{doc.summary}</div> : null}
      <div className="doc-card__meta">
        {doc.source ? <span>{doc.source}</span> : null}
        {"updated_at" in doc && doc.updated_at ? <time>{formatTimestamp(doc.updated_at)}</time> : null}
      </div>
      <div className="doc-card__actions">
        <button
          className="btn btn--sm"
          type="button"
          disabled={!canView}
          aria-controls={DOC_VIEWER_ID}
          aria-expanded={selected}
          onClick={(event) => onView(doc.id, event.currentTarget)}
        >
          <Icon name="doc" size={14} />
          <span>{t("knowledge.viewDocument")}</span>
        </button>
      </div>
    </div>
  );
}
