/* <KnowledgeCreateCard/> — the gated (manage_knowledge) "新增条目" form
   (legacy-app.js:1267-1289). A plain structured-text form (title / source /
   summary / content) — NO file upload (spec §0). The POST body sends the four
   field values verbatim; the response is ignored, the reload is the source of
   truth. Submit order matches legacy exactly: POST → clear inputs → reload →
   toast, all inside one runBusy (so inputs clear even if the reload fails). */

import { useState } from "react";
import { toast } from "../../context/ToastContext";
import { createDocument, loadDocuments } from "../../data/knowledgeActions";
import { runBusy } from "../../data/sessionActions";
import { useI18n } from "../../i18n";
import { useStore, useStoreHandle } from "../../store/useStore";
import { CardHead } from "../common/CardHead";
import { Field } from "../common/Field";
import { Icon } from "../common/Icon";

export function KnowledgeCreateCard() {
  const { t } = useI18n();
  const store = useStoreHandle();
  const busy = useStore((state) => state.busy);
  const [title, setTitle] = useState("");
  const [source, setSource] = useState("");
  const [summary, setSummary] = useState("");
  const [content, setContent] = useState("");

  return (
    <section className="card">
      <CardHead
        title={t("knowledge.createTitle")}
        icon="plus"
        desc={t("knowledge.createDescription")}
      />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void runBusy(store, async () => {
            await createDocument({ title, source, summary, content });
            setTitle("");
            setSource("");
            setSummary("");
            setContent("");
            await loadDocuments(store);
            toast(t("knowledge.saved"), { type: "ok", title: t("toast.complete") });
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
        <button className="btn btn--primary" type="submit" disabled={busy}>
          <Icon name="plus" size={16} />
          <span>{t("knowledge.save")}</span>
        </button>
      </form>
    </section>
  );
}
