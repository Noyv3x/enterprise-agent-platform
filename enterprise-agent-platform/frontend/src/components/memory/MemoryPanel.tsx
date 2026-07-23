import { Alert, Button, Card, Form, Input, Space, Tabs, Tag, Typography } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  approveAgentMemoryCandidate,
  clearAgentMemories,
  createAgentMemory,
  deleteAgentMemory,
  exportAgentMemories,
  loadAgentMemories,
  loadAgentMemoryCandidates,
  rejectAgentMemoryCandidate,
  updateAgentMemory,
} from "../../data/memoryActions";
import { toast } from "../../context/ToastContext";
import { intlLocale, useI18n } from "../../i18n";
import { downloadJson } from "../../lib/api";
import { cx } from "../../lib/cx";
import type { AgentMemory, AgentMemoryCandidate, AgentMemoryTarget } from "../../types";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { EmptyState } from "../common/EmptyState";
import { Icon } from "../common/Icon";
import { InlineAlert } from "../common/InlineAlert";
import { Spinner } from "../common/Spinner";
import "./memory.css";

const { TextArea } = Input;

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

interface MemoryCardProps {
  memory: AgentMemory;
  busy: boolean;
  editing: boolean;
  editContent: string;
  locale: string;
  onEditContent: (content: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onDelete: () => void;
}

function MemoryCard({
  memory,
  busy,
  editing,
  editContent,
  locale,
  onEditContent,
  onStartEdit,
  onCancelEdit,
  onSave,
  onDelete,
}: MemoryCardProps) {
  const { t } = useI18n();
  const updated = memoryTime(memory.updated_at, locale);
  return (
    <article className={cx("memory-card", editing && "is-editing", memory.blocked && "is-blocked")}>
      <Card className="memory-card__surface" classNames={{ body: "memory-card__body" }} size="small">
        {editing ? (
          <Form.Item className="memory-card__editor" label={t("memory.contentLabel")}>
            <TextArea
              autoFocus
              aria-label={t("memory.contentLabel")}
              value={editContent}
              maxLength={4000}
              disabled={busy}
              autoSize={{ minRows: 3, maxRows: 10 }}
              onChange={(event) => onEditContent(event.target.value)}
            />
          </Form.Item>
        ) : (
          <Typography.Paragraph className="memory-card__content">{memory.content}</Typography.Paragraph>
        )}
        {memory.blocked ? (
          <Alert
            className="memory-card__blocked"
            type="warning"
            showIcon
            title={t("memory.blockedTitle")}
            description={t("memory.blockedMessage")}
          />
        ) : null}
        {(memory.tags || []).length ? (
          <Space className="memory-card__tags" wrap aria-label={t("memory.tags")}>
            {(memory.tags || []).map((tag) => <Tag key={tag}>{tag}</Tag>)}
          </Space>
        ) : null}
        <footer className="memory-card__footer">
          <Typography.Text type="secondary">
            {updated ? t("memory.updatedAt", { time: updated }) : `#${memory.id}`}
          </Typography.Text>
          <Space className="memory-card__actions" wrap>
            {editing ? (
              <>
                <Button size="small" disabled={busy} onClick={onCancelEdit}>
                  {t("memory.cancel")}
                </Button>
                <Button
                  size="small"
                  type="primary"
                  loading={busy}
                  disabled={!editContent.trim()}
                  onClick={onSave}
                >
                  {t("memory.save")}
                </Button>
              </>
            ) : (
              <>
                <Button size="small" disabled={busy} onClick={onStartEdit}>
                  {t("memory.edit")}
                </Button>
                <Button
                  size="small"
                  danger
                  icon={<Icon name="trash" size={13} />}
                  disabled={busy}
                  onClick={onDelete}
                >
                  {t("memory.delete")}
                </Button>
              </>
            )}
          </Space>
        </footer>
      </Card>
    </article>
  );
}

function PendingCandidateCard({
  candidate,
  busy,
  locale,
  onApprove,
  onIgnore,
}: {
  candidate: AgentMemoryCandidate;
  busy: boolean;
  locale: string;
  onApprove: () => void;
  onIgnore: () => void;
}) {
  const { t } = useI18n();
  const created = memoryTime(candidate.created_at, locale);
  return (
    <article className="memory-candidate">
      <Card className="memory-candidate__surface" classNames={{ body: "memory-candidate__body" }} size="small">
        <header>
          <Tag
            className="memory-candidate__target"
            icon={<Icon name={candidate.target === "user" ? "users" : "bot"} size={13} />}
            color="blue"
          >
            {targetLabel(candidate.target, t)}
          </Tag>
          {created ? <Typography.Text type="secondary"><time>{created}</time></Typography.Text> : null}
        </header>
        <Typography.Paragraph>{candidate.content}</Typography.Paragraph>
        <footer>
          <Button size="small" disabled={busy} onClick={onIgnore}>
            {t("memory.ignore")}
          </Button>
          <Button size="small" type="primary" loading={busy} onClick={onApprove}>
            {t("memory.approve")}
          </Button>
        </footer>
      </Card>
    </article>
  );
}

export function MemoryPanel() {
  const { t, locale } = useI18n();
  const [target, setTarget] = useState<AgentMemoryTarget>("memory");
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [candidates, setCandidates] = useState<AgentMemoryCandidate[]>([]);
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [newContent, setNewContent] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editContent, setEditContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [candidatesLoading, setCandidatesLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [candidatesError, setCandidatesError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const memoryController = useRef<AbortController | null>(null);
  const candidateController = useRef<AbortController | null>(null);
  const memoryRequestVersion = useRef(0);
  const candidateRequestVersion = useRef(0);
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

  const refreshCandidates = useCallback(async () => {
    candidateController.current?.abort();
    const controller = new AbortController();
    const requestVersion = ++candidateRequestVersion.current;
    candidateController.current = controller;
    setCandidatesLoading(true);
    setCandidatesError("");
    try {
      const result = await loadAgentMemoryCandidates(controller.signal);
      if (!controller.signal.aborted && candidateRequestVersion.current === requestVersion) {
        setCandidates(result.candidates || []);
      }
    } catch (error) {
      if (!controller.signal.aborted && candidateRequestVersion.current === requestVersion) {
        setCandidatesError(errorText(error));
      }
    } finally {
      if (candidateController.current === controller) {
        candidateController.current = null;
        setCandidatesLoading(false);
      }
    }
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

  useEffect(() => {
    void refreshCandidates();
    return () => {
      const controller = candidateController.current;
      candidateController.current = null;
      candidateRequestVersion.current += 1;
      controller?.abort();
    };
  }, [refreshCandidates]);

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
    options: { refreshMemories?: boolean; refreshCandidates?: boolean } = {},
  ) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusyKey(key);
    setMutationError("");
    if (options.refreshMemories !== false) stopStaleMemoryLoad();
    try {
      await action();
      toast(successMessage, { type: "ok" });
      if (options.refreshCandidates) await refreshCandidates();
      if (options.refreshMemories !== false) await refreshMemories();
      return true;
    } catch (error) {
      setMutationError(errorText(error) || t("memory.mutationFailed"));
      return false;
    } finally {
      busyRef.current = false;
      setBusyKey("");
    }
  }, [refreshCandidates, refreshMemories, stopStaleMemoryLoad, t]);

  const switchTarget = (next: AgentMemoryTarget) => {
    if (next === target) return;
    targetRef.current = next;
    queryRef.current = "";
    setTarget(next);
    setMemories([]);
    setQuery("");
    setQueryDraft("");
    setNewContent("");
    setEditingId(null);
    setEditContent("");
    setMutationError("");
  };

  const addMemory = async () => {
    const content = newContent.trim();
    if (!content) {
      setMutationError(t("memory.required"));
      return;
    }
    const saved = await runMutation(
      "create",
      () => createAgentMemory({ target, content }),
      t("memory.createSuccess"),
    );
    if (saved) setNewContent("");
  };

  const saveMemory = async (memory: AgentMemory) => {
    const content = editContent.trim();
    if (!content) {
      setMutationError(t("memory.required"));
      return;
    }
    const saved = await runMutation(
      `update:${memory.id}`,
      () => updateAgentMemory(memory.id, {
        target: memory.target,
        content,
        // A blocked legacy record may carry an unsafe tag that this compact
        // editor does not expose. Clear its tags so a safe edit can restore it.
        tags: memory.blocked ? [] : memory.tags || [],
      }),
      t("memory.updateSuccess"),
    );
    if (saved) {
      setEditingId(null);
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

  const decideCandidate = async (candidate: AgentMemoryCandidate, decision: "approve" | "reject") => {
    const approved = decision === "approve";
    const changed = await runMutation(
      `candidate:${decision}:${candidate.id}`,
      () => approved
        ? approveAgentMemoryCandidate(candidate.id)
        : rejectAgentMemoryCandidate(candidate.id),
      t(approved ? "memory.approveSuccess" : "memory.ignoreSuccess"),
      { refreshMemories: approved, refreshCandidates: true },
    );
    if (changed && !approved) {
      setCandidates((current) => current.filter((item) => item.id !== candidate.id));
    }
  };

  const exportMemories = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyKey("export");
    setMutationError("");
    try {
      const payload = await exportAgentMemories();
      const stamp = new Date().toISOString().slice(0, 10);
      downloadJson(payload, `ubitech-agent-memories-${stamp}.json`);
      toast(t("memory.exportSuccess"), { type: "ok" });
    } catch (error) {
      setMutationError(errorText(error) || t("memory.exportFailed"));
    } finally {
      busyRef.current = false;
      setBusyKey("");
    }
  };

  const activeHint = target === "user" ? t("memory.target.userHint") : t("memory.target.agentHint");
  const clearLabel = target === "user" ? t("memory.clearTarget.user") : t("memory.clearTarget.agent");
  const emptyTitle = query ? t("memory.noResults") : t("memory.empty");
  const emptyDetail = query
    ? t("memory.noResultsDetail")
    : target === "user"
      ? t("memory.emptyDetail.user")
      : t("memory.emptyDetail.agent");

  const memoryTabPanel = (
    <div className="memory-tab-panel">
      <Typography.Paragraph className="memory-target-hint">{activeHint}</Typography.Paragraph>

      <Form
        className="memory-search"
        role="search"
        aria-label={t("memory.searchLabel")}
        onFinish={() => {
          const nextQuery = queryDraft.trim();
          queryRef.current = nextQuery;
          setQuery(nextQuery);
        }}
      >
        <Input
          className="memory-search__input"
          type="search"
          prefix={<Icon name="search" size={15} />}
          suffix={query ? (
            <Button
              type="text"
              size="small"
              shape="circle"
              aria-label={t("memory.clearSearch")}
              title={t("memory.clearSearch")}
              icon={<Icon name="close" size={14} />}
              onClick={() => {
                queryRef.current = "";
                setQuery("");
                setQueryDraft("");
              }}
            />
          ) : null}
          value={queryDraft}
          maxLength={4000}
          aria-label={t("memory.searchLabel")}
          placeholder={t("memory.searchPlaceholder")}
          onChange={(event) => setQueryDraft(event.target.value)}
        />
        <Button htmlType="submit">{t("memory.search")}</Button>
      </Form>

      <Form
        className="memory-add"
        layout="vertical"
        onFinish={() => void addMemory()}
      >
        <Form.Item label={t("memory.addTitle")}>
          <TextArea
            value={newContent}
            maxLength={4000}
            disabled={!!busyKey}
            autoSize={{ minRows: 3, maxRows: 10 }}
            aria-label={t("memory.addTitle")}
            placeholder={t(target === "user" ? "memory.addPlaceholder.user" : "memory.addPlaceholder.agent")}
            onChange={(event) => setNewContent(event.target.value)}
          />
        </Form.Item>
        <Button
          type="primary"
          htmlType="submit"
          loading={busyKey === "create"}
          icon={busyKey === "create" ? undefined : <Icon name="plus" size={14} />}
          disabled={!!busyKey || !newContent.trim()}
        >
          {t("memory.add")}
        </Button>
      </Form>

      {mutationError ? <InlineAlert variant="error">{mutationError}</InlineAlert> : null}

      <div className="memory-toolbar">
        <Typography.Text type="secondary">{t("memory.count", { count: memories.length })}</Typography.Text>
        <Space wrap>
          <Button
            size="small"
            disabled={!!busyKey}
            title={t("memory.refresh")}
            icon={<Icon name="refresh" size={14} />}
            onClick={() => {
              void refreshMemories();
              void refreshCandidates();
            }}
          >
            {t("memory.refresh")}
          </Button>
          <Button
            size="small"
            disabled={!!busyKey}
            icon={<Icon name="download" size={14} />}
            onClick={() => void exportMemories()}
          >
            {t("memory.export")}
          </Button>
          <Button
            size="small"
            danger
            disabled={!!busyKey}
            icon={<Icon name="trash" size={14} />}
            onClick={() => setConfirmation({ kind: "clear", target })}
          >
            {clearLabel}
          </Button>
        </Space>
      </div>

      {loadError ? (
        <InlineAlert
          variant="error"
          action={<Button size="small" onClick={() => void refreshMemories()}>{t("common.retry")}</Button>}
        >
          {loadError || t("memory.loadFailed")}
        </InlineAlert>
      ) : loading ? (
        <div className="memory-loading" role="status">
          <Spinner size={20} />
          <span>{t("memory.loading")}</span>
        </div>
      ) : memories.length ? (
        <div className="memory-list">
          {memories.map((memory) => (
            <MemoryCard
              key={memory.id}
              memory={memory}
              busy={!!busyKey}
              editing={editingId === memory.id}
              editContent={editingId === memory.id ? editContent : ""}
              locale={intl}
              onEditContent={setEditContent}
              onStartEdit={() => {
                setEditingId(memory.id);
                setEditContent(memory.content);
                setMutationError("");
              }}
              onCancelEdit={() => {
                setEditingId(null);
                setEditContent("");
              }}
              onSave={() => void saveMemory(memory)}
              onDelete={() => setConfirmation({ kind: "delete", memory })}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={query ? "search" : target === "user" ? "users" : "bot"}
          title={emptyTitle}
          text={emptyDetail}
        />
      )}
    </div>
  );

  return (
    <section className="memory-panel" aria-label={t("memory.title")}>
      <InlineAlert variant="warning" title={t("memory.chatNoticeTitle")}>
        {t("memory.chatNotice")}
      </InlineAlert>

      {(candidatesLoading || candidatesError || candidates.length > 0) ? (
        <section className="memory-pending" aria-labelledby="memory-pending-title">
          <header className="memory-section__head">
            <div>
              <h3 id="memory-pending-title">{t("memory.pendingTitle")}</h3>
              <p>{t("memory.pendingDescription")}</p>
            </div>
            {!candidatesLoading ? <Tag>{t("memory.pendingCount", { count: candidates.length })}</Tag> : null}
          </header>
          {candidatesError ? (
            <InlineAlert
              variant="error"
              action={<Button size="small" onClick={() => void refreshCandidates()}>{t("common.retry")}</Button>}
            >
              {candidatesError || t("memory.pendingLoadFailed")}
            </InlineAlert>
          ) : candidatesLoading ? (
            <div className="memory-loading" role="status">
              <Spinner size={18} />
              <span>{t("memory.loading")}</span>
            </div>
          ) : (
            <div className="memory-candidate-list">
              {candidates.map((candidate) => (
                <PendingCandidateCard
                  key={candidate.id}
                  candidate={candidate}
                  busy={!!busyKey}
                  locale={intl}
                  onApprove={() => void decideCandidate(candidate, "approve")}
                  onIgnore={() => void decideCandidate(candidate, "reject")}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}

      <Tabs
        className="memory-tabs"
        classNames={{
          header: "memory-tabs__header",
          item: "memory-tabs__item",
          indicator: "memory-tabs__indicator",
          body: "memory-tabs__body",
          content: "memory-tabs__content",
        }}
        activeKey={target}
        destroyOnHidden
        onChange={(key) => switchTarget(key as AgentMemoryTarget)}
        items={(["memory", "user"] as const).map((item) => ({
          key: item,
          label: (
            <Space size={7}>
              <Icon name={item === "user" ? "users" : "bot"} size={16} />
              {targetLabel(item, t)}
            </Space>
          ),
          children: item === target ? memoryTabPanel : null,
        }))}
      />

      {confirmation?.kind === "delete" ? (
        <ConfirmDialog
          title={t("memory.deleteConfirmTitle")}
          message={t("memory.deleteConfirm")}
          confirmText={t("memory.delete")}
          danger
          onCancel={() => setConfirmation(null)}
          onConfirm={() => void confirmDelete(confirmation.memory)}
        />
      ) : confirmation?.kind === "clear" ? (
        <ConfirmDialog
          title={t("memory.clearConfirmTitle", { target: targetLabel(confirmation.target, t) })}
          message={t("memory.clearConfirm")}
          confirmText={
            confirmation.target === "user"
              ? t("memory.clearTarget.user")
              : t("memory.clearTarget.agent")
          }
          danger
          onCancel={() => setConfirmation(null)}
          onConfirm={() => void confirmClear(confirmation.target)}
        />
      ) : null}
    </section>
  );
}
