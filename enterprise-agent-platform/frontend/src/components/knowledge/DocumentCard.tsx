/* <DocumentCard/> — one entry in the document list. Search hits and library
   rows share the same stable numeric document id, so either can open the
   authoritative source document. */

import { Button, Card } from "antd";
import { useI18n } from "../../i18n";
import type { KnowledgeDocument, KnowledgeHit } from "../../types";
import { formatTimestamp } from "../../utils/format";
import { Icon } from "../common/Icon";
import { DOC_VIEWER_ID } from "./DocumentViewer";

export interface DocumentCardProps {
  doc: KnowledgeDocument | KnowledgeHit;
  /** true when this card's document is the one currently open in the viewer. */
  selected: boolean;
  onView: (id: number, button: HTMLButtonElement) => void;
}

export function DocumentCard({ doc, selected, onView }: DocumentCardProps) {
  const { t } = useI18n();
  return (
    <Card
      className={`knowledge-document-card${selected ? " is-selected" : ""}`}
      classNames={{ body: "knowledge-document-card__body" }}
      size="small"
    >
      <div className="knowledge-document-card__title">
        <Icon name="doc" />
        <span>{doc.title}</span>
      </div>
      {doc.summary ? <div className="knowledge-document-card__summary">{doc.summary}</div> : null}
      <div className="knowledge-document-card__meta">
        {doc.source ? <span>{doc.source}</span> : null}
        {"updated_at" in doc && doc.updated_at ? <time>{formatTimestamp(doc.updated_at)}</time> : null}
      </div>
      <div className="knowledge-document-card__actions">
        <Button
          size="small"
          icon={<Icon name="doc" size={14} />}
          aria-controls={DOC_VIEWER_ID}
          aria-expanded={selected}
          onClick={(event) => onView(doc.id, event.currentTarget as HTMLButtonElement)}
        >
          {t("knowledge.viewDocument")}
        </Button>
      </div>
    </Card>
  );
}
