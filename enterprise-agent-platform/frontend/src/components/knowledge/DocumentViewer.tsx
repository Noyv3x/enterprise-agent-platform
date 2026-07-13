/* <DocumentViewer/> — the inline full-document panel (legacy renderDocViewer,
   legacy-app.js:1331-1339). Text-only <pre> (never HTML). Focus handoff:
   - on open, focus moves into the viewer (its close button);
   - on close, the parent restores focus to the triggering "查看正文" button.
   This was impossible under the legacy full-teardown render and is the main a11y
   win for this view. The panel is an inline region, not a modal. */

import { useEffect, useRef } from "react";
import { useI18n } from "../../i18n";
import type { FullDocument } from "../../types";
import { Icon } from "../common/Icon";

/** Stable id so each doc-card's view button can aria-control the viewer. */
export const DOC_VIEWER_ID = "knowledge-doc-viewer";

export interface DocumentViewerProps {
  document: FullDocument;
  onClose: () => void;
  showClose?: boolean;
}

export function DocumentViewer({ document: doc, onClose, showClose = true }: DocumentViewerProps) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Focus handoff on open. The restore-to-trigger on close lives in the parent's
  // onClose (it owns the reference to the button that opened the viewer).
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <div
      className="doc-viewer"
      id={DOC_VIEWER_ID}
      role="region"
      aria-label={t("knowledge.documentRegion")}
    >
      <div className="doc-viewer__bar">
        <span className="eyebrow">{doc.title || t("knowledge.untitledDocument")}</span>
        {showClose ? <button
          ref={closeRef}
          className="icon-btn"
          type="button"
          title={t("common.close")}
          aria-label={t("knowledge.closeDocument")}
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </button> : null}
      </div>
      <pre>{doc.content}</pre>
    </div>
  );
}
