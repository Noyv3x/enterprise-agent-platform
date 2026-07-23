import { Button, Card, Form, Input, Space, Switch, Tag, Typography } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "../../context/ToastContext";
import {
  createAgentSkill,
  deleteAgentSkill,
  loadAgentSkill,
  loadAgentSkills,
  updateAgentSkill,
} from "../../data/skillActions";
import { intlLocale, useI18n } from "../../i18n";
import { cx } from "../../lib/cx";
import type {
  AgentPreviewScope,
  AgentSkill,
  AgentSkillCreateRequest,
} from "../../types";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { EmptyState } from "../common/EmptyState";
import { Icon } from "../common/Icon";
import { InlineAlert } from "../common/InlineAlert";
import { Spinner } from "../common/Spinner";
import "./skills.css";

const { TextArea } = Input;

interface SkillDraft {
  name: string;
  description: string;
  instructions: string;
  category: string;
  version: string;
  tags: string;
  enabled: boolean;
}

type SkillEditor =
  | { mode: "create"; draft: SkillDraft; linkedFileCount: 0 }
  | { mode: "edit"; id: string; draft: SkillDraft; linkedFileCount: number }
  | { mode: "view"; id: string; draft: SkillDraft; linkedFileCount: number; preset: boolean }
  | null;

interface DeleteConfirmation {
  skill: AgentSkill;
  scope: AgentPreviewScope;
}

function emptyDraft(): SkillDraft {
  return {
    name: "",
    description: "",
    instructions: "",
    category: "",
    version: "",
    tags: "",
    enabled: true,
  };
}

function draftFromSkill(skill: AgentSkill): SkillDraft {
  return {
    name: skill.name || "",
    description: skill.description || "",
    instructions: skill.instructions || "",
    category: skill.category || "",
    version: skill.version || "",
    tags: (skill.tags || []).join(", "),
    enabled: !!skill.enabled,
  };
}

function tagsFromDraft(value: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of value.split(",")) {
    const tag = raw.trim().slice(0, 64);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= 20) break;
  }
  return tags;
}

function payloadFromDraft(draft: SkillDraft): AgentSkillCreateRequest {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    instructions: draft.instructions.trim(),
    category: draft.category.trim(),
    version: draft.version.trim(),
    tags: tagsFromDraft(draft.tags),
    enabled: draft.enabled,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function skillTime(value: string | null | undefined, locale: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

interface SkillCardProps {
  skill: AgentSkill;
  busy: boolean;
  canManage: boolean;
  locale: string;
  onToggle: () => void;
  onEdit: (trigger: HTMLElement) => void;
  onDelete: () => void;
}

function SkillCard({
  skill,
  busy,
  canManage,
  locale,
  onToggle,
  onEdit,
  onDelete,
}: SkillCardProps) {
  const { t } = useI18n();
  const updated = skillTime(skill.updated_at, locale);
  const linkedFileCount = (skill.linked_files || []).length;
  const readOnly = skill.read_only === true || skill.source === "bundled";
  const toggleLabel = t(skill.enabled ? "skills.disable" : "skills.enable");

  return (
    <article className={cx("skill-card", !skill.enabled && "is-disabled")}>
      <Card className="skill-card__surface" classNames={{ body: "skill-card__body" }} size="small">
        <header className="skill-card__head">
          <div className="skill-card__identity">
            <span className="skill-card__icon"><Icon name="sparkles" size={15} /></span>
            <div>
              <Typography.Title level={3}>{skill.name}</Typography.Title>
              <Space className="skill-card__states" size={5} wrap>
                <Tag color={skill.enabled ? "success" : "default"}>
                  {t(skill.enabled ? "skills.enabled" : "skills.disabled")}
                </Tag>
                {readOnly ? <Tag color="blue">{t("skills.preset")}</Tag> : null}
              </Space>
            </div>
          </div>
          {canManage && !readOnly ? (
            <Switch
              checked={skill.enabled}
              aria-label={`${toggleLabel} ${skill.name}`}
              title={`${toggleLabel} ${skill.name}`}
              disabled={busy}
              loading={busy}
              onChange={onToggle}
            />
          ) : null}
        </header>

        <Typography.Paragraph className="skill-card__description">{skill.description}</Typography.Paragraph>

        {(skill.category || skill.version) ? (
          <Space className="skill-card__meta" size={5} wrap>
            {skill.category ? <Tag>{skill.category}</Tag> : null}
            {skill.version ? <Tag>v{skill.version}</Tag> : null}
          </Space>
        ) : null}

        {(skill.tags || []).length ? (
          <Space className="skill-card__tags" size={5} wrap aria-label={t("skills.form.tags")}>
            {(skill.tags || []).map((tag) => <Tag key={tag}>{tag}</Tag>)}
          </Space>
        ) : null}

        <footer className="skill-card__footer">
          <div>
            <Typography.Text type="secondary">{t("skills.attachments", { count: linkedFileCount })}</Typography.Text>
            {updated ? <Typography.Text type="secondary">{t("skills.updatedAt", { time: updated })}</Typography.Text> : null}
          </div>
          {readOnly ? (
            <Space className="skill-card__actions">
              <Button
                size="small"
              aria-label={t("skills.viewNamed", { name: skill.name })}
              disabled={busy}
              onClick={(event) => onEdit(event.currentTarget)}
            >
              {t("skills.view")}
              </Button>
            </Space>
          ) : canManage ? (
            <Space className="skill-card__actions" wrap>
              <Button
                size="small"
                disabled={busy}
                onClick={(event) => onEdit(event.currentTarget)}
              >
                {t("skills.edit")}
              </Button>
              <Button
                size="small"
                danger
                icon={<Icon name="trash" size={13} />}
                disabled={busy}
                onClick={onDelete}
              >
                {t("skills.delete")}
              </Button>
            </Space>
          ) : null}
        </footer>
      </Card>
    </article>
  );
}

function SkillEditorForm({
  editor,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  editor: Exclude<SkillEditor, null>;
  busy: boolean;
  onChange: (next: SkillDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useI18n();
  const { draft } = editor;
  const readOnly = editor.mode === "view";
  const preset = editor.mode === "view" && editor.preset;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const requiredReady = !!(
    draft.name.trim()
    && draft.description.trim()
    && draft.instructions.trim()
  );
  const update = <K extends keyof SkillDraft>(key: K, value: SkillDraft[K]) => {
    onChange({ ...draft, [key]: value });
  };

  useEffect(() => {
    if (!readOnly) return;
    const heading = headingRef.current;
    if (!heading) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView?.({ block: "nearest" });
  }, [editor, readOnly]);

  return (
    <Form className="skill-editor" layout="vertical" onFinish={onSubmit}>
      <header className="skill-editor__head">
        <div>
          <span className="skill-editor__icon"><Icon name="sparkles" size={16} /></span>
          <h3 ref={headingRef} tabIndex={readOnly ? -1 : undefined}>{t(
            editor.mode === "create"
              ? "skills.createTitle"
              : editor.mode === "view"
                ? "skills.viewTitle"
                : "skills.editTitle",
          )}</h3>
        </div>
        <Button
          type="text"
          shape="circle"
          aria-label={t(readOnly ? "skills.close" : "skills.cancel")}
          title={t(readOnly ? "skills.close" : "skills.cancel")}
          disabled={busy}
          onClick={onCancel}
          icon={<Icon name="close" size={15} />}
        >
        </Button>
      </header>

      <div className="skill-editor__grid">
        <Form.Item label={t("skills.form.name")} required>
          <Input
            aria-label={t("skills.form.name")}
            autoFocus={!readOnly}
            value={draft.name}
            maxLength={64}
            disabled={busy}
            readOnly={readOnly}
            placeholder={t("skills.form.namePlaceholder")}
            onChange={(event) => update("name", event.target.value)}
          />
        </Form.Item>
        <Form.Item label={t("skills.form.category")}>
          <Input
            aria-label={t("skills.form.category")}
            value={draft.category}
            maxLength={64}
            disabled={busy}
            readOnly={readOnly}
            placeholder={t("skills.form.categoryPlaceholder")}
            onChange={(event) => update("category", event.target.value)}
          />
        </Form.Item>
        <Form.Item label={t("skills.form.version")}>
          <Input
            aria-label={t("skills.form.version")}
            value={draft.version}
            maxLength={32}
            disabled={busy}
            readOnly={readOnly}
            placeholder={t("skills.form.versionPlaceholder")}
            onChange={(event) => update("version", event.target.value)}
          />
        </Form.Item>
        <Form.Item className="skill-editor__wide" label={t("skills.form.description")} required>
          <Input
            aria-label={t("skills.form.description")}
            value={draft.description}
            maxLength={1024}
            disabled={busy}
            readOnly={readOnly}
            placeholder={t("skills.form.descriptionPlaceholder")}
            onChange={(event) => update("description", event.target.value)}
          />
        </Form.Item>
        <Form.Item
          className="skill-editor__wide"
          label={t("skills.form.tags")}
          extra={t("skills.form.tagsHint")}
        >
          <Input
            aria-label={t("skills.form.tags")}
            value={draft.tags}
            maxLength={1320}
            disabled={busy}
            readOnly={readOnly}
            placeholder={t("skills.form.tagsPlaceholder")}
            onChange={(event) => update("tags", event.target.value)}
          />
        </Form.Item>
        <Form.Item
          className="skill-editor__wide"
          label={t("skills.form.instructions")}
          required
          extra={t("skills.form.instructionsHint")}
        >
          <TextArea
            className="skill-editor__instructions"
            aria-label={t("skills.form.instructions")}
            value={draft.instructions}
            maxLength={65_536}
            spellCheck
            disabled={busy}
            readOnly={readOnly}
            placeholder={t("skills.form.instructionsPlaceholder")}
            onChange={(event) => update("instructions", event.target.value)}
            autoSize={{ minRows: 10, maxRows: 22 }}
          />
        </Form.Item>
      </div>

      {editor.linkedFileCount > 0 ? (
        <div className="skill-editor__attachments" role="note">
          <Icon name="paperclip" size={14} />
          <span>
            <strong>{t("skills.attachments", { count: editor.linkedFileCount })}</strong>
            {t(preset ? "skills.presetAttachmentsReadOnly" : "skills.attachmentsReadOnly")}
          </span>
        </div>
      ) : null}

      {preset ? (
        <InlineAlert variant="info">{t("skills.presetHint")}</InlineAlert>
      ) : readOnly ? null : (
        <label className="skill-editor__enabled">
          <Switch
            checked={draft.enabled}
            aria-label={t("skills.form.enabled")}
            disabled={busy}
            onChange={(checked) => update("enabled", checked)}
          />
          <span>{t("skills.form.enabled")}</span>
        </label>
      )}

      <footer className="skill-editor__actions">
        <Button disabled={busy} onClick={onCancel}>
          {t(readOnly ? "skills.close" : "skills.cancel")}
        </Button>
        {!readOnly ? (
          <Button type="primary" htmlType="submit" loading={busy} disabled={!requiredReady}>
            {t("skills.save")}
          </Button>
        ) : null}
      </footer>
    </Form>
  );
}

export function SkillsPanel({
  scope,
  canManage = true,
}: {
  scope: AgentPreviewScope;
  canManage?: boolean;
}) {
  const { t, locale } = useI18n();
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<SkillEditor>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [confirmation, setConfirmation] = useState<DeleteConfirmation | null>(null);
  const listController = useRef<AbortController | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const listRequestVersion = useRef(0);
  const detailRequestVersion = useRef(0);
  const busyRef = useRef(false);
  const canManageRef = useRef(canManage);
  const detailTriggerRef = useRef<HTMLElement | null>(null);
  const scopeRef = useRef(scope);
  const queryRef = useRef(query);
  const scopeKey = `${scope.scope_type}:${scope.scope_id}`;
  canManageRef.current = canManage;
  scopeRef.current = scope;
  queryRef.current = query;
  const intl = intlLocale(locale);

  const refreshSkills = useCallback(async () => {
    const requestedScope = { ...scopeRef.current };
    const requestedScopeKey = `${requestedScope.scope_type}:${requestedScope.scope_id}`;
    const requestedQuery = queryRef.current;
    listController.current?.abort();
    const controller = new AbortController();
    const requestVersion = ++listRequestVersion.current;
    listController.current = controller;
    setLoading(true);
    setLoadError("");
    try {
      const result = await loadAgentSkills(requestedScope, requestedQuery, controller.signal);
      const currentScope = scopeRef.current;
      if (
        !controller.signal.aborted
        && listRequestVersion.current === requestVersion
        && `${currentScope.scope_type}:${currentScope.scope_id}` === requestedScopeKey
        && queryRef.current === requestedQuery
      ) {
        setSkills(result.skills || []);
      }
    } catch (error) {
      const currentScope = scopeRef.current;
      if (
        !controller.signal.aborted
        && listRequestVersion.current === requestVersion
        && `${currentScope.scope_type}:${currentScope.scope_id}` === requestedScopeKey
        && queryRef.current === requestedQuery
      ) {
        setLoadError(errorText(error));
      }
    } finally {
      if (listController.current === controller) {
        listController.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    setSkills([]);
    setEditor(null);
    setConfirmation(null);
    setMutationError("");
    setQuery("");
    setQueryDraft("");
    queryRef.current = "";
    detailController.current?.abort();
    detailController.current = null;
    detailRequestVersion.current += 1;
    detailTriggerRef.current = null;
  }, [scopeKey]);

  useEffect(() => {
    if (canManage) return;
    detailController.current?.abort();
    detailController.current = null;
    detailRequestVersion.current += 1;
    detailTriggerRef.current = null;
    setEditor(null);
    setConfirmation(null);
    setMutationError("");
  }, [canManage]);

  useEffect(() => {
    void refreshSkills();
    return () => {
      const controller = listController.current;
      listController.current = null;
      listRequestVersion.current += 1;
      controller?.abort();
    };
  }, [query, refreshSkills, scopeKey]);

  useEffect(() => () => {
    detailController.current?.abort();
    detailController.current = null;
    detailRequestVersion.current += 1;
  }, []);

  const stopStaleListLoad = useCallback(() => {
    listController.current?.abort();
    listController.current = null;
    listRequestVersion.current += 1;
    setLoading(false);
  }, []);

  const runMutation = useCallback(async (
    key: string,
    actionScope: AgentPreviewScope,
    action: () => Promise<unknown>,
    successMessage: string,
    closeEditor = false,
  ) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusyKey(key);
    setMutationError("");
    stopStaleListLoad();
    detailController.current?.abort();
    detailController.current = null;
    detailRequestVersion.current += 1;
    try {
      await action();
      toast(successMessage, { type: "ok" });
      const currentScope = scopeRef.current;
      if (
        closeEditor
        && currentScope.scope_type === actionScope.scope_type
        && String(currentScope.scope_id) === String(actionScope.scope_id)
      ) {
        setEditor(null);
      }
      await refreshSkills();
      return true;
    } catch (error) {
      setMutationError(errorText(error) || t("skills.mutationFailed"));
      return false;
    } finally {
      busyRef.current = false;
      setBusyKey("");
    }
  }, [refreshSkills, stopStaleListLoad, t]);

  const openCreate = () => {
    if (!canManage || busyRef.current) return;
    detailController.current?.abort();
    detailController.current = null;
    detailRequestVersion.current += 1;
    detailTriggerRef.current = null;
    setEditor({ mode: "create", draft: emptyDraft(), linkedFileCount: 0 });
    setMutationError("");
  };

  const openEdit = async (skill: AgentSkill, trigger: HTMLElement) => {
    const listReadOnly = skill.read_only === true || skill.source === "bundled";
    if ((!canManageRef.current && !listReadOnly) || busyRef.current) return;
    detailTriggerRef.current = trigger;
    busyRef.current = true;
    setBusyKey(`detail:${skill.id}`);
    setMutationError("");
    detailController.current?.abort();
    const controller = new AbortController();
    const requestVersion = ++detailRequestVersion.current;
    const requestedScope = { ...scopeRef.current };
    const requestedScopeKey = `${requestedScope.scope_type}:${requestedScope.scope_id}`;
    detailController.current = controller;
    try {
      const result = await loadAgentSkill(requestedScope, skill.id, controller.signal);
      const currentScope = scopeRef.current;
      if (
        !controller.signal.aborted
        && detailRequestVersion.current === requestVersion
        && `${currentScope.scope_type}:${currentScope.scope_id}` === requestedScopeKey
      ) {
        const detailed = result.skill;
        const preset = detailed.read_only === true || detailed.source === "bundled";
        const viewOnly = preset || !canManageRef.current;
        const detail = {
          id: detailed.id,
          draft: draftFromSkill(detailed),
          linkedFileCount: (detailed.linked_files || []).length,
        };
        setEditor(viewOnly
          ? { mode: "view", preset, ...detail }
          : { mode: "edit", ...detail });
      }
    } catch (error) {
      if (!controller.signal.aborted && detailRequestVersion.current === requestVersion) {
        if (detailTriggerRef.current === trigger) detailTriggerRef.current = null;
        setMutationError(errorText(error) || t("skills.detailLoadFailed"));
      }
    } finally {
      if (detailController.current === controller) detailController.current = null;
      if (
        detailTriggerRef.current === trigger
        && (
          controller.signal.aborted
          || detailRequestVersion.current !== requestVersion
        )
      ) {
        detailTriggerRef.current = null;
      }
      busyRef.current = false;
      setBusyKey("");
    }
  };

  const saveEditor = async () => {
    if (!canManage || !editor || editor.mode === "view") return;
    const payload = payloadFromDraft(editor.draft);
    if (!payload.name || !payload.description || !payload.instructions) {
      setMutationError(t("skills.form.required"));
      return;
    }
    const actionScope = { ...scopeRef.current };
    if (editor.mode === "create") {
      await runMutation(
        "create",
        actionScope,
        () => createAgentSkill(actionScope, payload),
        t("skills.createSuccess"),
        true,
      );
      return;
    }
    const skillId = editor.id;
    await runMutation(
      `update:${skillId}`,
      actionScope,
      () => updateAgentSkill(actionScope, skillId, payload),
      t("skills.updateSuccess"),
      true,
    );
  };

  const toggleSkill = async (skill: AgentSkill) => {
    if (!canManage) return;
    const actionScope = { ...scopeRef.current };
    const enabled = !skill.enabled;
    await runMutation(
      `toggle:${skill.id}`,
      actionScope,
      () => updateAgentSkill(actionScope, skill.id, { enabled }),
      t(enabled ? "skills.enableSuccess" : "skills.disableSuccess"),
    );
  };

  const confirmDelete = async (value: DeleteConfirmation) => {
    if (!canManage) return;
    setConfirmation(null);
    await runMutation(
      `delete:${value.skill.id}`,
      value.scope,
      () => deleteAgentSkill(value.scope, value.skill.id),
      t("skills.deleteSuccess"),
      editor?.mode === "edit" && editor.id === value.skill.id,
    );
  };

  const emptyTitle = query ? t("skills.noResults") : t("skills.empty");
  const emptyDetail = query ? t("skills.noResultsDetail") : t("skills.emptyDetail");

  return (
    <section className="skills-panel" aria-label={t("skills.title")}>
      <InlineAlert variant="info" title={t("skills.noticeTitle")}>
        {t("skills.notice")}
      </InlineAlert>

      <div className="skills-toolbar">
        <Form
          className="skills-search"
          role="search"
          aria-label={t("skills.searchLabel")}
          onFinish={() => {
            const nextQuery = queryDraft.trim();
            queryRef.current = nextQuery;
            setQuery(nextQuery);
          }}
        >
          <Input
            type="search"
            aria-label={t("skills.searchLabel")}
            prefix={<Icon name="search" size={15} />}
            value={queryDraft}
            maxLength={4000}
            placeholder={t("skills.searchPlaceholder")}
            onChange={(event) => setQueryDraft(event.target.value)}
          />
          {query ? (
            <Button
              aria-label={t("skills.clearSearch")}
              title={t("skills.clearSearch")}
              icon={<Icon name="close" size={14} />}
              onClick={() => {
                queryRef.current = "";
                setQuery("");
                setQueryDraft("");
              }}
            />
          ) : null}
          <Button htmlType="submit">{t("skills.search")}</Button>
        </Form>
        {canManage ? (
          <Button type="primary" disabled={!!busyKey} onClick={openCreate} icon={<Icon name="plus" size={14} />}>
            {t("skills.create")}
          </Button>
        ) : null}
      </div>

      {editor ? (
        <SkillEditorForm
          editor={editor}
          busy={!!busyKey}
          onChange={(draft) => setEditor((current) => current ? { ...current, draft } : current)}
          onCancel={() => {
            if (busyRef.current) return;
            const trigger = detailTriggerRef.current;
            detailTriggerRef.current = null;
            setEditor(null);
            setMutationError("");
            if (trigger?.isConnected) trigger.focus();
          }}
          onSubmit={() => void saveEditor()}
        />
      ) : null}

      {mutationError ? <InlineAlert variant="error">{mutationError}</InlineAlert> : null}

      <div className="skills-list-head">
        {busyKey.startsWith("detail:") ? (
          <span className="skills-list-head__loading" role="status">
            <Spinner size={12} />
            {t("skills.loadingDetail")}
          </span>
        ) : (
          <span>{t("skills.count", { count: skills.length })}</span>
        )}
        <Button
          size="small"
          disabled={!!busyKey}
          title={t("skills.refresh")}
          icon={<Icon name="refresh" size={14} />}
          onClick={() => void refreshSkills()}
        >
          {t("skills.refresh")}
        </Button>
      </div>

      {loadError ? (
        <InlineAlert
          variant="error"
          action={(
            <Button size="small" onClick={() => void refreshSkills()}>
              {t("common.retry")}
            </Button>
          )}
        >
          {loadError || t("skills.loadFailed")}
        </InlineAlert>
      ) : loading ? (
        <div className="skills-loading" role="status">
          <Spinner size={20} />
          <span>{busyKey.startsWith("detail:") ? t("skills.loadingDetail") : t("skills.loading")}</span>
        </div>
      ) : skills.length ? (
        <div className="skills-list">
          {skills.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              busy={!!busyKey}
              canManage={canManage}
              locale={intl}
              onToggle={() => void toggleSkill(skill)}
              onEdit={(trigger) => void openEdit(skill, trigger)}
              onDelete={() => setConfirmation({
                skill,
                scope: { ...scopeRef.current },
              })}
            />
          ))}
        </div>
      ) : (
        <EmptyState icon={query ? "search" : "sparkles"} title={emptyTitle} text={emptyDetail} />
      )}

      {confirmation ? (
        <ConfirmDialog
          title={t("skills.deleteConfirmTitle", { name: confirmation.skill.name })}
          message={t("skills.deleteConfirm")}
          confirmText={t("skills.delete")}
          danger
          onCancel={() => setConfirmation(null)}
          onConfirm={() => void confirmDelete(confirmation)}
        />
      ) : null}
    </section>
  );
}
