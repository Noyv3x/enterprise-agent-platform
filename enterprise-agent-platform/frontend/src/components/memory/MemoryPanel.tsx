import { Button, Form, Input, Modal, Segmented, Space, Tag } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { clearAgentMemories, createAgentMemory, deleteAgentMemory, exportAgentMemories, loadAgentMemories, updateAgentMemory } from "../../data/memoryActions";
import { toast } from "../../context/ToastContext";
import { intlLocale, useI18n } from "../../i18n";
import { downloadJson } from "../../lib/api";
import type { AgentMemory, AgentMemoryTarget } from "../../types";
import { CapabilityHeader, SearchToolbar, DataRegion, EmptyState, FormFooter, Glyph, Notice, OverlayPanel, ResourceList, ResourceRow, Section, useFieldworkContainer } from "../ui/fieldwork";
import "./memory.css";

type Confirmation =
  | { kind: "delete"; memory: AgentMemory }
  | { kind: "clear"; target: AgentMemoryTarget }
  | null;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function memoryTime(value: number | string, locale: string): string {
  if (value == null || value === "") return "";
  const numeric = typeof value === "number" ? value : Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function targetLabel(target: AgentMemoryTarget, translate: ReturnType<typeof useI18n>["t"]): string {
  return translate(target === "user" ? "memory.target.user" : "memory.target.agent");
}

export function MemoryPanel() {
  const { t, locale } = useI18n();
  const getContainer = useFieldworkContainer();
  const [target, setTarget] = useState<AgentMemoryTarget>("memory");
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [newContent, setNewContent] = useState("");
  const [editorMemory, setEditorMemory] = useState<AgentMemory | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const targetEpoch = useRef(0);
  const draftRevision = useRef(0);
  const editorRevision = useRef(0);
  const mounted = useRef(true);
  const memoryController = useRef<AbortController | null>(null);
  const memoryRequestVersion = useRef(0);
  const busyRef = useRef(false);
  const targetRef = useRef<AgentMemoryTarget>(target);
  const queryRef = useRef(query);
  targetRef.current = target;
  queryRef.current = query;
  const intl = intlLocale(locale);

  const refreshMemories = useCallback(async () => {
    const requestedTarget = targetRef.current;
    const requestedQuery = queryRef.current;
    memoryController.current?.abort();
    const controller = new AbortController();
    const requestVersion = ++memoryRequestVersion.current;
    memoryController.current = controller;
    setLoading(true);
    setLoadError("");
    try {
      const result = await loadAgentMemories(requestedTarget, requestedQuery, controller.signal);
      if (
        !controller.signal.aborted
        && memoryRequestVersion.current === requestVersion
        && targetRef.current === requestedTarget
        && queryRef.current === requestedQuery
      ) {
        setMemories(result.memories || []);
      }
    } catch (error) {
      if (
        !controller.signal.aborted
        && memoryRequestVersion.current === requestVersion
        && targetRef.current === requestedTarget
        && queryRef.current === requestedQuery
      ) {
        setLoadError(errorText(error));
      }
    } finally {
      if (memoryController.current === controller) {
        memoryController.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    void refreshMemories();
    return () => {
      const controller = memoryController.current;
      memoryController.current = null;
      memoryRequestVersion.current += 1;
      controller?.abort();
    };
  }, [query, refreshMemories, target]);

  const stopStaleMemoryLoad = useCallback(() => {
    memoryController.current?.abort();
    memoryController.current = null;
    memoryRequestVersion.current += 1;
    setLoading(false);
  }, []);

  const runMutation = useCallback(async (
    key: string,
    action: () => Promise<unknown>,
    successMessage: string,
    options: { refreshMemories?: boolean } = {},
  ) => {
    if (busyRef.current) return false;
    const mutationEpoch = targetEpoch.current;
    busyRef.current = true;
    setBusyKey(key);
    setMutationError("");
    if (options.refreshMemories !== false) stopStaleMemoryLoad();
    try {
      await action();
      if (!mounted.current) return false;
      toast(successMessage, { type: "ok" });
      if (options.refreshMemories !== false) await refreshMemories();
      return true;
    } catch (error) {
      if (mounted.current && targetEpoch.current === mutationEpoch) setMutationError(errorText(error) || t("memory.mutationFailed"));
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusyKey("");
    }
  }, [refreshMemories, stopStaleMemoryLoad, t]);

  const switchTarget = (next: AgentMemoryTarget) => {
    if (next === target) return;
    stopStaleMemoryLoad();
    targetEpoch.current += 1;
    draftRevision.current += 1;
    editorRevision.current += 1;
    targetRef.current = next;
    queryRef.current = "";
    setTarget(next);
    setLoading(true);
    setLoadError("");
    setConfirmation(null);
    setCreateOpen(false);
    setMemories([]);
    setQuery("");
    setQueryDraft("");
    setNewContent("");
    setEditorMemory(null);
    setEditContent("");
    setMutationError("");
  };

  const addMemory = async () => {
    const content = newContent.trim();
    if (!content) {
      setMutationError(t("memory.required"));
      return;
    }
    const epoch = targetEpoch.current;
    const revision = draftRevision.current;
    const saved = await runMutation(
      "create",
      () => createAgentMemory({ target, content }),
      t("memory.createSuccess"),
    );
    if (saved && mounted.current && targetEpoch.current === epoch && draftRevision.current === revision) {
      setNewContent("");
      setCreateOpen(false);
    }
  };

  const saveMemory = async (memory: AgentMemory) => {
    const content = editContent.trim();
    if (!content) {
      setMutationError(t("memory.required"));
      return;
    }
    const epoch = targetEpoch.current;
    const revision = editorRevision.current;
    const saved = await runMutation(
      `update:${memory.id}`,
      () => updateAgentMemory(memory.id, {
        target: memory.target,
        content,
        // Unsafe hidden tags must not survive a blocked record’s safe replacement.
        tags: memory.blocked ? [] : memory.tags || [],
      }),
      t("memory.updateSuccess"),
    );
    if (saved && mounted.current && targetEpoch.current === epoch && editorRevision.current === revision) {
      setEditorMemory(null);
      setEditContent("");
    }
  };

  const confirmDelete = async (memory: AgentMemory) => {
    setConfirmation(null);
    await runMutation(
      `delete:${memory.id}`,
      () => deleteAgentMemory(memory.id),
      t("memory.deleteSuccess"),
    );
  };

  const confirmClear = async (clearTarget: AgentMemoryTarget) => {
    setConfirmation(null);
    await runMutation(
      `clear:${clearTarget}`,
      () => clearAgentMemories(clearTarget),
      t("memory.clearSuccess"),
    );
  };

  const exportMemories = async () => {
    if (busyRef.current) return;
    const exportEpoch = targetEpoch.current;
    busyRef.current = true;
    setBusyKey("export");
    setMutationError("");
    try {
      const payload = await exportAgentMemories();
      if (!mounted.current) return;
      const stamp = new Date().toISOString().slice(0, 10);
      downloadJson(payload, `agent-memories-${stamp}.json`);
      toast(t("memory.exportSuccess"), { type: "ok" });
    } catch (error) {
      if (mounted.current && targetEpoch.current === exportEpoch) setMutationError(errorText(error) || t("memory.exportFailed"));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusyKey("");
    }
  };

  const busy = !!busyKey;
  const clearLabel = t(target === "user" ? "memory.clearTarget.user" : "memory.clearTarget.agent");
  const submitQuery = (value: string) => {
    const next = value.trim();
    stopStaleMemoryLoad();
    queryRef.current = next;
    setMemories([]);
    if (next === query) void refreshMemories();
    else setQuery(next);
  };
  const closeEditor = () => {
    editorRevision.current += 1;
    draftRevision.current += 1;
    setCreateOpen(false);
    setEditorMemory(null);
  };

  return (
    <div className="wf-memory" aria-label={t("memory.title")}>
      <CapabilityHeader
        title={t("memory.title")}
        description={t(target === "user" ? "memory.target.userHint" : "memory.target.agentHint")}
        scope={targetLabel(target, t)}
        actions={<Space wrap>
          <Button onClick={() => { draftRevision.current += 1; setEditorMemory(null); setCreateOpen(true); }}>{t("memory.addTitle")}</Button>
          <Button disabled={busy} onClick={() => void refreshMemories()}>{t("memory.refresh")}</Button>
          <Button loading={busyKey === "export"} disabled={busy} onClick={() => void exportMemories()}>{t("memory.export")}</Button>
        </Space>}
      />
      <Notice title={t("memory.chatNoticeTitle")}>{t("memory.chatNotice")}</Notice>
      <Segmented
        block
        aria-label={t("memory.title")}
        value={target}
        options={(["memory", "user"] as const).map((value) => ({ value, label: targetLabel(value, t) }))}
        onChange={(value) => switchTarget(value as AgentMemoryTarget)}
      />
      <SearchToolbar search={
        <Form className="wf-memory-search" role="search" aria-label={t("memory.searchLabel")} onFinish={() => submitQuery(queryDraft)}>
          <Input type="search" maxLength={4000} aria-label={t("memory.searchLabel")} placeholder={t("memory.searchPlaceholder")} value={queryDraft} onChange={(event) => setQueryDraft(event.target.value)} />
          <Button htmlType="submit">{t("memory.search")}</Button>
          <Button disabled={!query && !queryDraft} onClick={() => { setQueryDraft(""); submitQuery(""); }}>{t("memory.clearSearch")}</Button>
        </Form>
      } />
      {mutationError && !createOpen && !editorMemory ? <Notice tone="danger" title={mutationError} /> : null}
      <DataRegion
        state={memories.length ? "ready" : loading ? "loading" : loadError ? "error" : "empty"}
        loadingLabel={t("memory.loading")}
        refreshing={loading && memories.length > 0}
        refreshingLabel={t("memory.loading")}
        error={loadError || undefined}
        retry={<Button onClick={() => void refreshMemories()}>{t("common.retry")}</Button>}
        empty={<EmptyState compact title={t(query ? "memory.noResults" : "memory.empty")} description={t(query ? "memory.noResultsDetail" : target === "user" ? "memory.emptyDetail.user" : "memory.emptyDetail.agent")} />}
      >
        <ResourceList label={t("memory.title")}>
          {memories.map((memory) => (
            <ResourceRow
              key={memory.id}
              leading={<Glyph name="memory" size={16} />}
              title={<span className="wf-memory-content">{memory.content}</span>}
              meta={t("memory.updatedAt", { time: memoryTime(memory.updated_at, intl) })}
              description={memory.tags?.length ? <Space wrap aria-label={t("memory.tags")}>{memory.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</Space> : undefined}
              actions={<Space wrap>
                <Button disabled={loading} onClick={() => { editorRevision.current += 1; setEditorMemory(memory); setEditContent(memory.content); setMutationError(""); }}>{t("memory.edit")}</Button>
                <Button danger disabled={busy || loading} onClick={() => setConfirmation({ kind: "delete", memory })}>{t("memory.delete")}</Button>
              </Space>}
            >
              {memory.blocked ? <Notice tone="warning" title={t("memory.blockedTitle")}>{t("memory.blockedMessage")}</Notice> : null}
            </ResourceRow>
          ))}
        </ResourceList>
      </DataRegion>
      <Section tone="danger"><Button danger disabled={busy || loading} onClick={() => setConfirmation({ kind: "clear", target })}>{clearLabel}</Button></Section>
      <OverlayPanel
        open={createOpen || editorMemory !== null}
        onClose={closeEditor}
        title={t(createOpen ? "memory.addTitle" : "memory.contentLabel")}
        closeLabel={t("common.close")}
      >
        <Form layout="vertical" onFinish={() => { if (createOpen) void addMemory(); else if (editorMemory) void saveMemory(editorMemory); }}>
          {editorMemory?.blocked ? <Notice tone="warning" title={t("memory.blockedTitle")}>{t("memory.blockedMessage")}</Notice> : null}
          <Form.Item label={t(createOpen ? "memory.addTitle" : "memory.contentLabel")}>
            <Input.TextArea
              autoFocus
              aria-label={t(createOpen ? "memory.addTitle" : "memory.contentLabel")}
              maxLength={4000}
              showCount
              autoSize={{ minRows: 6, maxRows: 16 }}
              value={createOpen ? newContent : editContent}
              onChange={(event) => {
                if (createOpen) { draftRevision.current += 1; setNewContent(event.target.value); }
                else { editorRevision.current += 1; setEditContent(event.target.value); }
              }}
            />
          </Form.Item>
          {mutationError ? <Notice tone="danger" title={mutationError} /> : null}
          <FormFooter>
            <Button onClick={closeEditor}>{t("memory.cancel")}</Button>
            <Button type="primary" htmlType="submit" loading={busyKey === "create" || busyKey.startsWith("update:")} disabled={busy || !(createOpen ? newContent : editContent).trim()}>{t(createOpen ? "memory.add" : "memory.save")}</Button>
          </FormFooter>
        </Form>
      </OverlayPanel>
      {confirmation ? <Modal
        getContainer={getContainer}
        open={confirmation !== null}
        title={confirmation?.kind === "delete" ? t("memory.deleteConfirmTitle") : t("memory.clearConfirmTitle", { target: targetLabel(confirmation?.kind === "clear" ? confirmation.target : target, t) })}
        onCancel={() => setConfirmation(null)}
        onOk={() => { if (confirmation?.kind === "delete") void confirmDelete(confirmation.memory); else if (confirmation?.kind === "clear") void confirmClear(confirmation.target); }}
        okText={confirmation?.kind === "delete" ? t("memory.delete") : t(confirmation?.kind === "clear" && confirmation.target === "user" ? "memory.clearTarget.user" : "memory.clearTarget.agent")}
        cancelText={t("memory.cancel")}
        okButtonProps={{ danger: true, disabled: busy }}
      >
        {t(confirmation?.kind === "delete" ? "memory.deleteConfirm" : "memory.clearConfirm")}
      </Modal> : null}
    </div>
  );
}
