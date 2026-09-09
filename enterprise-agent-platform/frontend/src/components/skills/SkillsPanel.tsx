import { Button, Form, Input, Space, Switch } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "../../context/ToastContext";
import { createAgentSkill, deleteAgentSkill, loadAgentSkill, loadAgentSkills, updateAgentSkill } from "../../data/skillActions";
import { intlLocale, useI18n } from "../../i18n";
import type { AgentPreviewScope, AgentSkill, AgentSkillCreateRequest } from "../../types";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { CapabilityHeader, SearchToolbar, ResourceList, ResourceRow, StatusMark, Notice, DataRegion, EmptyState, FormGrid, FormFooter, OverlayPanel } from "../ui/fieldwork";
import "./skills.css";

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
  | { mode: "edit"; id: string; draft: SkillDraft; linkedFileCount: number; source?: AgentSkill["source"] }
  | { mode: "view"; id: string; draft: SkillDraft; linkedFileCount: number; preset: boolean; source?: AgentSkill["source"] }
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

function SkillEditorForm({ editor, busy, error, onChange, onCancel, onSubmit }: {
  editor: Exclude<SkillEditor, null>; busy: boolean; error: string;
  onChange: (draft: SkillDraft) => void; onCancel: () => void; onSubmit: () => void;
}) {
  const { t } = useI18n();
  const readOnly = editor.mode === "view";
  const preset = readOnly && editor.preset;
  const draft = editor.draft;
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (readOnly) headingRef.current?.focus({ preventScroll: true });
  }, [editor, readOnly]);
  const requiredReady = Boolean(draft.name.trim() && draft.description.trim() && draft.instructions.trim());
  const fields = [
    ["name", 64], ["category", 64], ["version", 32], ["description", 1024], ["tags", 1320], ["instructions", 65_536],
  ] as const;
  return <OverlayPanel open onClose={() => { if (!busy) onCancel(); }} closeLabel={t("skills.close")}
    title={<h3 ref={headingRef} tabIndex={readOnly ? -1 : undefined}>{t(editor.mode === "create" ? "skills.createTitle" : readOnly ? "skills.viewTitle" : "skills.editTitle")}</h3>} size="wide">
    <Form layout="vertical" onFinish={onSubmit}>
      {error ? <Notice tone="danger" title={error}/> : null}
      {preset ? <Notice tone="info" title={t("skills.preset")} >{t("skills.presetHint")}</Notice> : null}
      {editor.mode !== "create" && editor.source ? <p>{t("skills.source")}: {t(editor.source === "bundled" ? "skills.source.bundled" : "skills.source.user")}</p> : null}
      <FormGrid>{fields.map(([key, limit]) => <Form.Item key={key} label={t(`skills.form.${key}`)} required={key === "name" || key === "description" || key === "instructions"}
        extra={key === "tags" ? t("skills.form.tagsHint") : key === "instructions" ? t("skills.form.instructionsHint") : undefined}>
        {key === "instructions" ? <Input.TextArea className="wf-skill-instructions" aria-label={t(`skills.form.${key}`)} value={draft[key]} maxLength={limit} readOnly={readOnly} disabled={busy} autoSize={{minRows:10,maxRows:22}} onChange={event => onChange({...draft,[key]:event.target.value})} />
          : <Input aria-label={t(`skills.form.${key}`)} value={draft[key]} maxLength={limit} readOnly={readOnly} disabled={busy} autoFocus={key === "name" && !readOnly} placeholder={t(`skills.form.${key}Placeholder`)} onChange={event => onChange({...draft,[key]:event.target.value})} />}
      </Form.Item>)}</FormGrid>
      {editor.linkedFileCount > 0 ? <Notice tone="info" title={t("skills.attachments",{count:editor.linkedFileCount})}>{t(preset ? "skills.presetAttachmentsReadOnly" : "skills.attachmentsReadOnly")}</Notice> : null}
      {!readOnly ? <Form.Item label={t("skills.form.enabled")}><Switch aria-label={t("skills.form.enabled")} checked={draft.enabled} disabled={busy} onChange={enabled => onChange({...draft,enabled})}/></Form.Item> : null}
      <FormFooter><Button onClick={onCancel} disabled={busy}>{t(readOnly ? "skills.close" : "skills.cancel")}</Button>{!readOnly ? <Button htmlType="submit" type="primary" loading={busy} disabled={!requiredReady}>{t("skills.save")}</Button> : null}</FormFooter>
    </Form>
  </OverlayPanel>;
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
  const scopeEpoch = useRef({ key: scopeKey, version: 0 });
  if (scopeEpoch.current.key !== scopeKey) scopeEpoch.current = { key: scopeKey, version: scopeEpoch.current.version + 1 };
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
    const actionVersion = scopeEpoch.current.version;
    busyRef.current = true;
    setBusyKey(key);
    setMutationError("");
    stopStaleListLoad();
    detailController.current?.abort();
    detailController.current = null;
    detailRequestVersion.current += 1;
    try {
      await action();
      const currentScope = scopeRef.current;
      if (scopeEpoch.current.version !== actionVersion || currentScope.scope_type !== actionScope.scope_type || String(currentScope.scope_id) !== String(actionScope.scope_id)) return false;
      toast(successMessage, { type: "ok" });
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
      const currentScope = scopeRef.current;
      if (scopeEpoch.current.version === actionVersion && currentScope.scope_type === actionScope.scope_type && String(currentScope.scope_id) === String(actionScope.scope_id)) setMutationError(errorText(error) || t("skills.mutationFailed"));
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
          source: detailed.source,
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

  return <section className="wf-skills" aria-label={t("skills.title")}>
    <CapabilityHeader title={t("skills.title")} description={t("skills.notice")} actions={<Space wrap>
      <Button disabled={!!busyKey || loading} onClick={() => void refreshSkills()}>{t("skills.refresh")}</Button>
      {canManage ? <Button type="primary" disabled={!!busyKey || loading} onClick={openCreate}>{t("skills.create")}</Button> : null}
    </Space>} />
    <SearchToolbar search={<Form role="search" aria-label={t("skills.searchLabel")} onFinish={() => { const next = queryDraft.trim(); queryRef.current = next; setQuery(next); }}>
      <Space.Compact block><Input type="search" aria-label={t("skills.searchLabel")} value={queryDraft} maxLength={4000} placeholder={t("skills.searchPlaceholder")} onChange={event => setQueryDraft(event.target.value)}/><Button htmlType="submit">{t("skills.search")}</Button>
      {query ? <Button onClick={() => {queryRef.current="";setQuery("");setQueryDraft("");}}>{t("skills.clearSearch")}</Button> : null}</Space.Compact>
    </Form>} />
    {mutationError ? <Notice tone="danger" title={mutationError}/> : null}
    {busyKey.startsWith("detail:") ? <p role="status">{t("skills.loadingDetail")}</p> : null}
    <DataRegion state={skills.length ? "ready" : loading ? "loading" : loadError ? "error" : "empty"} loadingLabel={t("skills.loading")} refreshing={loading && !!skills.length} refreshingLabel={t("skills.loading")} error={loadError} retry={<Button onClick={() => void refreshSkills()}>{t("common.retry")}</Button>} empty={<EmptyState title={emptyTitle} description={emptyDetail}/>}>
      <ResourceList label={t("skills.count",{count:skills.length})}>{skills.map(item => {
        const readOnly = item.read_only === true || item.source === "bundled";
        return <ResourceRow key={item.id} title={<h3>{item.name}</h3>} description={item.description}
          meta={<Space wrap>{item.category}{item.version ? `v${item.version}` : null}{item.tags?.join(", ")}<span>{t("skills.attachments",{count:item.linked_files?.length || 0})}</span>{skillTime(item.updated_at,intl)}{item.source ? <span>{t(item.source === "bundled" ? "skills.source.bundled" : "skills.source.user")}</span> : null}</Space>}
          status={<Space wrap><StatusMark tone={item.enabled ? "success" : "neutral"}>{t(item.enabled ? "skills.enabled" : "skills.disabled")}</StatusMark>{readOnly ? <StatusMark tone="info">{t("skills.preset")}</StatusMark> : null}</Space>}
          actions={<Space wrap>{canManage && !readOnly ? <Switch checked={item.enabled} disabled={!!busyKey || loading} aria-label={`${t(item.enabled ? "skills.disable" : "skills.enable")} ${item.name}`} onChange={() => void toggleSkill(item)}/> : null}
            {canManage || readOnly ? <Button disabled={!!busyKey || loading} aria-label={readOnly ? t("skills.viewNamed",{name:item.name}) : undefined} onClick={event => void openEdit(item,event.currentTarget)}>{t(readOnly ? "skills.view" : "skills.edit")}</Button> : null}
            {canManage && !readOnly ? <Button danger disabled={!!busyKey || loading} onClick={() => setConfirmation({skill:item,scope:{...scopeRef.current}})}>{t("skills.delete")}</Button> : null}</Space>}/>;
      })}</ResourceList>
    </DataRegion>
    {editor ? <SkillEditorForm editor={editor} busy={!!busyKey} error={mutationError} onChange={draft => setEditor(current => current ? {...current,draft} : current)} onCancel={() => {if(busyRef.current)return;const trigger=detailTriggerRef.current;detailTriggerRef.current=null;setEditor(null);setMutationError("");if(trigger?.isConnected)trigger.focus();}} onSubmit={() => void saveEditor()}/> : null}
    {confirmation ? <ConfirmDialog title={t("skills.deleteConfirmTitle",{name:confirmation.skill.name})} message={t("skills.deleteConfirm")} confirmText={t("skills.delete")} danger onCancel={() => setConfirmation(null)} onConfirm={() => void confirmDelete(confirmation)}/> : null}
  </section>;
}
