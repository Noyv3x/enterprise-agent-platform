/* <KnowledgeView/> — the knowledge route view (legacy renderKnowledge,
   legacy-app.js:1226-1329). The create card is gated on manage_knowledge; when
   absent the grid collapses to a single column. Data loading is owned by the
   sidebar nav handler (navigateToView → loadDocuments) exactly as in legacy, so
   this view does not fetch on mount — it renders whatever the store holds. */

import { usePermissions } from "../../hooks/usePermissions";
import { cx } from "../../lib/cx";
import { KnowledgeCreateCard } from "./KnowledgeCreateCard";
import { KnowledgeLibraryCard } from "./KnowledgeLibraryCard";

export function KnowledgeView() {
  const canManage = usePermissions().has("manage_knowledge");
  return (
    <div className="panel">
      <div className="panel__inner">
        <div className={cx("kb-grid", !canManage && "kb-grid--single")}>
          {canManage ? <KnowledgeCreateCard /> : null}
          <KnowledgeLibraryCard />
        </div>
      </div>
    </div>
  );
}
