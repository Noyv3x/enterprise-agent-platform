/* <KnowledgeView/> — the knowledge route view (legacy renderKnowledge,
   legacy-app.js:1226-1329). The create card is gated on manage_knowledge; when
   absent the grid collapses to a single column. Data loading is owned by the
   sidebar nav handler (navigateToView → loadDocuments) exactly as in legacy, so
   this view does not fetch on mount — it renders whatever the store holds. */

import { Button, Space, Tag } from "antd";
import { useState } from "react";
import { usePermissions } from "../../hooks/usePermissions";
import { useConfirm } from "../../hooks/useConfirm";
import { useI18n } from "../../i18n";
import { useStore } from "../../store/useStore";
import { Drawer } from "../common/Drawer";
import { Icon } from "../common/Icon";
import { PageHeader } from "../common/PageHeader";
import { KnowledgeCreateCard } from "./KnowledgeCreateCard";
import { KnowledgeLibraryCard } from "./KnowledgeLibraryCard";
import "./knowledge.css";

export function KnowledgeView() {
  const canManage = usePermissions().has("manage_knowledge");
  const { t } = useI18n();
  const count = useStore((state) => state.documents.length);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDirty, setCreateDirty] = useState(false);
  const { confirm, dialog } = useConfirm();

  const closeCreate = async () => {
    if (createDirty) {
      const discard = await confirm(t("knowledge.discardMessage"), {
        title: t("knowledge.discardTitle"),
        confirmText: t("knowledge.discardConfirm"),
        danger: true,
      });
      if (!discard) return;
    }
    setCreateOpen(false);
    setCreateDirty(false);
  };

  return (
    <div className="panel">
      <div className="panel__inner knowledge-panel">
        <PageHeader
          title={t("knowledge.library")}
          description={t("knowledge.pageDescription")}
          actions={
            <Space className="knowledge-header-actions" wrap>
              <Tag
                className="knowledge-count"
                icon={<Icon name="doc" size={13} />}
              >
                {t("knowledge.documentCount", { count })}
              </Tag>
              {canManage ? (
                <Button
                  type="primary"
                  icon={<Icon name="plus" size={16} />}
                  onClick={() => setCreateOpen(true)}
                >
                  {t("knowledge.createTitle")}
                </Button>
              ) : null}
            </Space>
          }
        />
        <KnowledgeLibraryCard />
      </div>
      <Drawer
        open={createOpen}
        onClose={() => void closeCreate()}
        title={t("knowledge.createTitle")}
        description={t("knowledge.createDescription")}
      >
        <KnowledgeCreateCard
          onDirtyChange={setCreateDirty}
          onSaved={() => {
            setCreateDirty(false);
            setCreateOpen(false);
          }}
        />
      </Drawer>
      {dialog}
    </div>
  );
}
