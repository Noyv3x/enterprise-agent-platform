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
import { useStore, useStoreHandle } from "../../store/useStore";
import { CardHead } from "../common/CardHead";
import { Field } from "../common/Field";
import { Icon } from "../common/Icon";

export function KnowledgeCreateCard() {
  const store = useStoreHandle();
  const busy = useStore((state) => state.busy);
  const [title, setTitle] = useState("");
  const [source, setSource] = useState("");
  const [summary, setSummary] = useState("");
  const [content, setContent] = useState("");

  return (
    <section className="card">
      <CardHead title="新增条目" icon="plus" desc="结构化录入知识，供 Agent 检索引用。" />
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
            toast("已保存知识条目", { type: "ok", title: "完成" });
          });
        }}
      >
        <Field label="标题">
          <input
            placeholder="标题"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label="来源">
          <input
            placeholder="来源（URL、系统名等）"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
        </Field>
        <Field label="摘要">
          <input
            placeholder="摘要（可留空）"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
        </Field>
        <Field label="正文">
          <textarea
            placeholder="正文内容…"
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
        </Field>
        <button className="btn btn--primary" type="submit" disabled={busy}>
          <Icon name="plus" size={16} />
          <span>保存条目</span>
        </button>
      </form>
    </section>
  );
}
