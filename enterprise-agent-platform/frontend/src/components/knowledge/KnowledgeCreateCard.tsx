/* <KnowledgeCreateCard/> — the gated (manage_knowledge) "新增条目" form
   (legacy-app.js:1267-1289). A plain structured-text form (title / source /
   summary / content) — NO file upload (spec §0). The POST body sends the four
   field values verbatim; the response is ignored, the reload is the source of
   truth. Submit order matches legacy exactly: POST → clear inputs → reload →
   toast, all inside one runBusy (so inputs clear even if the reload fails). */

import { useEffect, useState } from "react";
import { toast } from "../../context/ToastContext";
import { createDocument, loadDocuments } from "../../data/knowledgeActions";
import { resourceKeys, runResourceLoad } from "../../data/resourceState";
import { runBusy } from "../../data/sessionActions";
import { useI18n } from "../../i18n";
import { useStore, useStoreHandle } from "../../store/useStore";
import { Field } from "../common/Field";
import { Icon } from "../common/Icon";

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
  const dirty = !!(title || source || summary || content);

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  return (
    <div className="knowledge-create">
      <form
        onSubmit={(event) => {
          event.preventDefault();
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
        <Field label={t("knowledge.title")}>
          <input
            placeholder={t("knowledge.title")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label={t("knowledge.source")}>
          <input
            placeholder={t("knowledge.sourcePlaceholder")}
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
        </Field>
        <Field label={t("knowledge.summary")}>
          <input
            placeholder={t("knowledge.summaryPlaceholder")}
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
        </Field>
        <Field label={t("knowledge.content")}>
          <textarea
            placeholder={t("knowledge.contentPlaceholder")}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
        </Field>
        <button className="btn btn--primary" type="submit" disabled={busy || !title.trim() || !content.trim()}>
          <Icon name="plus" size={16} />
          <span>{t("knowledge.save")}</span>
        </button>
      </form>
    </div>
  );
}
