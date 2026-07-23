/* <KnowledgeCreateCard/> — the gated (manage_knowledge) "新增条目" form
   (legacy-app.js:1267-1289). A plain structured-text form (title / source /
   summary / content) — NO file upload (spec §0). The POST body sends the four
   field values verbatim; the response is ignored, the reload is the source of
   truth. Submit order matches legacy exactly: POST → clear inputs → reload →
   toast, all inside one runBusy (so inputs clear even if the reload fails). */

import { Button, Form, Input } from "antd";
import { useEffect, useId, useState } from "react";
import { toast } from "../../context/ToastContext";
import { createDocument, loadDocuments } from "../../data/knowledgeActions";
import { resourceKeys, runResourceLoad } from "../../data/resourceState";
import { runBusy } from "../../data/sessionActions";
import { useI18n } from "../../i18n";
import { useStore, useStoreHandle } from "../../store/useStore";
import { Icon } from "../common/Icon";

const { TextArea } = Input;

export function KnowledgeCreateCard({
  onSaved,
  onDirtyChange,
}: {
  onSaved?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useI18n();
  const store = useStoreHandle();
  const busy = useStore((state) => state.pendingOperations.includes("knowledge:create"));
  const [title, setTitle] = useState("");
  const [source, setSource] = useState("");
  const [summary, setSummary] = useState("");
  const [content, setContent] = useState("");
  const fieldPrefix = useId();
  const dirty = !!(title || source || summary || content);

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  return (
    <div className="knowledge-create">
      <Form
        layout="vertical"
        requiredMark="optional"
        onFinish={() => {
          void runBusy(store, "knowledge:create", async () => {
            await createDocument({ title, source, summary, content });
            setTitle("");
            setSource("");
            setSummary("");
            setContent("");
            await runResourceLoad(store, resourceKeys.knowledgeList, () => loadDocuments(store));
            toast(t("knowledge.saved"), { type: "ok", title: t("toast.complete") });
            onSaved?.();
          });
        }}
      >
        <Form.Item label={t("knowledge.title")} htmlFor={`${fieldPrefix}-title`} required>
          <Input
            id={`${fieldPrefix}-title`}
            placeholder={t("knowledge.title")}
            value={title}
            maxLength={255}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Form.Item>
        <Form.Item label={t("knowledge.source")} htmlFor={`${fieldPrefix}-source`}>
          <Input
            id={`${fieldPrefix}-source`}
            placeholder={t("knowledge.sourcePlaceholder")}
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
        </Form.Item>
        <Form.Item label={t("knowledge.summary")} htmlFor={`${fieldPrefix}-summary`}>
          <Input
            id={`${fieldPrefix}-summary`}
            placeholder={t("knowledge.summaryPlaceholder")}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
        </Form.Item>
        <Form.Item label={t("knowledge.content")} htmlFor={`${fieldPrefix}-content`} required>
          <TextArea
            id={`${fieldPrefix}-content`}
            className="knowledge-create__content"
            autoSize={{ minRows: 10, maxRows: 22 }}
            placeholder={t("knowledge.contentPlaceholder")}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
        </Form.Item>
        <Button
          type="primary"
          htmlType="submit"
          icon={<Icon name="plus" size={16} />}
          loading={busy}
          disabled={!title.trim() || !content.trim()}
        >
          {t("knowledge.save")}
        </Button>
      </Form>
    </div>
  );
}
