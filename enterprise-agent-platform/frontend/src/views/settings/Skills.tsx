import { useId, useState, type ReactNode } from "react";
import { request, type SkillList, type SkillTier, type SkillView } from "../../api";
import { Switch } from "../../components/ui/beautiful/atoms/Switch";
import { Button } from "../../components/ui/beautiful/atoms/Button";
import { ConfirmDialog, EmptyState, Icon, Notice, TextField } from "../../components/ui/beautiful/controls";
import LoadingState from "../../components/ui/beautiful/primitives/LoadingState";
import { RecordTag } from "../../components/ui/beautiful/primitives/RecordsTable";
import { useWords } from "../../words";
import { errorText, useResource } from "../admin/shared";
import { InstallDialog } from "../skills/InstallDialog";
import { SkillSheet } from "../skills/SkillSheet";
import { matches, skillPath, useSkillLabels } from "../skills/skills";

type Busy = "toggle" | "update" | "delete";
type Outcome = { tone: "success" | "danger"; text: string } | null;

const ICON_BUTTON = "flex size-8 shrink-0 items-center justify-center rounded-[6px] text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-50 touch:size-11";
const DANGER_BUTTON = "bg-red-tint text-red-ink shadow-none hover:bg-red-tint hover:brightness-95";

/** Settings → Skills: the skills this account's AI can use, in three groups (personal, organization, built-in),
 * each with its own on/off preference. Personal skills can be installed, updated from their link and deleted when
 * the account's group grants `install_extensions`; the server checks that permission either way. */
export function SkillSettings({ scope }: { scope: "private" | "chat" }) {
  const w = useWords();
  const labels = useSkillLabels();
  const list = useResource<SkillList>(`/api/skills?scope=${scope}`);
  const [query, setQuery] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [deleting, setDeleting] = useState<SkillView | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [busy, setBusy] = useState<Record<string, Busy>>({});
  const [outcome, setOutcome] = useState<Outcome>(null);

  const skills = list.data?.skills ?? [];
  const canInstall = scope === "private" && list.data?.can_install === true;
  const needle = query.trim().toLowerCase();
  const opened = skills.find((skill) => skill.key === openKey) ?? null;

  // Install, update and delete can change which tier wins a name (a personal skill overrides an organization or
  // built-in one of the same name), so they reload the catalog. A preference changes only its own row.
  async function act(skill: SkillView, kind: Busy, run: () => Promise<void>) {
    if (busy[skill.key]) return;
    setBusy((current) => ({ ...current, [skill.key]: kind }));
    setOutcome(null);
    try {
      await run();
    } catch (cause) {
      if (kind === "delete") setDeleteError(errorText(cause));
      else setOutcome({ tone: "danger", text: kind === "update" ? labels.updateFailure(skill.name, cause) : errorText(cause) });
    } finally {
      setBusy(({ [skill.key]: _done, ...rest }) => rest);
    }
  }
  const toggle = (skill: SkillView, enabled: boolean) => act(skill, "toggle", async () => {
    const next = (await request<{ skill: SkillView }>(`${skillPath(skill.key)}/preference`, { method: "PUT", body: JSON.stringify({ enabled }) })).skill;
    list.setData((current) => current && { ...current, skills: current.skills.map((item) => (item.key === next.key ? next : item)) });
  });
  const update = (skill: SkillView) => act(skill, "update", async () => {
    await request<{ skill: SkillView }>(`${skillPath(skill.key)}/update`, { method: "POST", body: "{}" });
    await list.reload(true);
    setOutcome({ tone: "success", text: w(`${skill.name} is up to date. The AI uses the new version from the next message.`, `${skill.name} 已更新，AI 从下一条消息起使用新版本。`, `${skill.name} 已更新，AI 從下一則訊息起使用新版本。`) });
  });
  const remove = (skill: SkillView) => act(skill, "delete", async () => {
    await request<{ ok: true }>(skillPath(skill.key), { method: "DELETE" });
    setDeleting(null);
    if (openKey === skill.key) setOpenKey(null);
    await list.reload(true);
    setOutcome({ tone: "success", text: w(`${skill.name} was deleted.`, `已删除 ${skill.name}。`, `已刪除 ${skill.name}。`) });
  });

  if (list.state !== "ready") {
    return list.state === "loading"
      ? <LoadingState label={w("Loading skills…", "正在加载技能…", "正在載入技能…")} />
      : <Notice tone="danger" title={w("Skills could not be loaded", "无法加载技能", "無法載入技能")}
        action={<Button size="sm" className="touch:h-11" onClick={() => void list.reload()}>{w("Retry", "重试", "重試")}</Button>}>{list.error}</Notice>;
  }

  const install = <Button size="sm" variant="primary" className="touch:h-11 touch:px-4" onClick={() => setInstalling(true)}>
    <Icon name="plus" size={14} />{w("Install skill", "安装技能", "安裝技能")}
  </Button>;
  const actionsFor = (skill: SkillView) => ({
    update: skill.manageable && skill.source?.kind === "url",
    remove: skill.tier === "personal" && skill.manageable,
  });
  const groups: { tier: SkillTier; title: string; hint: string; empty: ReactNode }[] = [
    ...(scope === "private" && (canInstall || skills.some((skill) => skill.tier === "personal")) ? [{
      tier: "personal" as const,
      title: w("Personal", "个人", "個人"),
      hint: w("Installed by you or your AI; only your personal AI uses them.", "你或 AI 安装的技能，只在你的个人 AI 中使用。", "你或 AI 安裝的技能，只在你的個人 AI 中使用。"),
      empty: <EmptyState icon="sparkle" title={w("No personal skills yet", "还没有个人技能", "還沒有個人技能")}
        description={w("Upload a ZIP or .skill file, paste a link, or ask your personal AI to install one for you.", "上传 ZIP 或 .skill 文件、粘贴链接，或者直接让个人 AI 帮你安装。", "上傳 ZIP 或 .skill 檔案、貼上連結，或者直接讓個人 AI 幫你安裝。")}
        action={canInstall ? install : undefined} />,
    }] : []),
    {
      tier: "org",
      title: w("Organization", "组织", "組織"),
      hint: w("Provided by your administrators for your permission group.", "管理员为你的权限组提供的技能。", "管理員為你的權限群組提供的技能。"),
      empty: w("No organization skills yet. Skills your administrators assign to you appear here.", "暂无组织技能。管理员分配给你的技能会显示在这里。", "尚無組織技能。管理員指派給你的技能會顯示在這裡。"),
    },
    {
      tier: "builtin",
      title: w("Built-in", "内置", "內建"),
      hint: w("Ship with the platform.", "随平台提供。", "隨平台提供。"),
      empty: w("No built-in skills are available.", "没有可用的内置技能。", "沒有可用的內建技能。"),
    },
  ];
  const shown = groups.map((group) => ({ ...group, skills: skills.filter((skill) => skill.tier === group.tier && matches(skill, needle)) }));
  const nothingMatches = needle !== "" && shown.every((group) => group.skills.length === 0);
  const openedActions = opened ? actionsFor(opened) : null;

  return <div className="flex flex-col gap-5">
    <div className="flex flex-wrap items-center gap-2">
      <TextField type="search" value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-[200px] flex-1"
        aria-label={w("Search skills", "搜索技能", "搜尋技能")} placeholder={w("Search skill names or descriptions", "搜索技能名称或说明", "搜尋技能名稱或說明")}
        leading={<Icon name="search" size={15} />} />
      {canInstall && install}
    </div>
    {scope === "private" && !canInstall && (
      <Notice tone="info" title={w("Your permission group cannot install skills", "你的权限组不能安装技能", "你的權限群組不能安裝技能")}>
        {w("Personal skills are not loaded, and installing, updating or deleting them is unavailable. Ask an administrator for “Install skills and connectors” if you need it.",
          "个人技能不会加载，也不能安装、更新或删除。如有需要，请联系管理员开通“安装技能和连接器”权限。",
          "個人技能不會載入，也不能安裝、更新或刪除。如有需要，請聯絡管理員開通「安裝技能和連接器」權限。")}
      </Notice>
    )}
    {outcome && !opened && <Notice tone={outcome.tone} title={outcome.text} onDismiss={() => setOutcome(null)} />}
    {nothingMatches
      ? <EmptyState title={w(`No skills match “${query.trim()}”`, `没有符合“${query.trim()}”的技能`, `沒有符合「${query.trim()}」的技能`)}
        description={w("Try another name or a word from the description.", "换个名称，或用说明里的词试试。", "換個名稱，或用說明裡的詞試試。")} />
      : shown.map((group) => (needle && group.skills.length === 0 ? null : (
        <SkillGroup key={group.tier} title={group.title} hint={group.hint} count={group.skills.length} empty={group.empty}>
          {group.skills.map((skill) => {
            const actions = actionsFor(skill);
            const state = busy[skill.key];
            return <li key={skill.key} className="flex items-center gap-2 border-b border-line py-1.5 pr-3 pl-1.5 transition-colors duration-100 last:border-0 hover:bg-inset sm:pr-4">
              <button type="button" onClick={() => { setOutcome(null); setOpenKey(skill.key); }} className="flex min-w-0 flex-1 flex-col items-start gap-1 rounded-control px-2 py-1.5 text-left">
                <span className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 truncate text-[13px] font-medium text-ink">{skill.name}</span>
                  <RecordTag tag={labels.tag(skill)} />
                  {labels.version(skill) && <span className="font-mono text-[11.5px] text-ink-2">{labels.version(skill)}</span>}
                  {skill.warnings.length > 0 && <span className="inline-flex items-center gap-1 text-[11.5px] text-orange-ink"><Icon name="warning" size={12} strokeWidth={2} />{labels.warnings(skill.warnings.length)}</span>}
                </span>
                <span className="line-clamp-2 text-[12.5px] leading-[1.45] text-ink-2">{skill.description}</span>
              </button>
              {actions.update && (
                <button type="button" className={ICON_BUTTON} disabled={Boolean(state)} aria-busy={state === "update" || undefined}
                  aria-label={w(`Update ${skill.name} from its link`, `从链接更新 ${skill.name}`, `從連結更新 ${skill.name}`)} title={w("Update from link", "从链接更新", "從連結更新")}
                  onClick={() => void update(skill)}>
                  <Icon name="refresh" size={15} className={state === "update" ? "animate-spin" : undefined} />
                </button>
              )}
              {actions.remove && (
                <button type="button" className={ICON_BUTTON} disabled={Boolean(state)}
                  aria-label={w(`Delete ${skill.name}`, `删除 ${skill.name}`, `刪除 ${skill.name}`)} title={w("Delete", "删除", "刪除")}
                  onClick={() => { setDeleteError(""); setDeleting(skill); }}>
                  <Icon name="trash" size={15} />
                </button>
              )}
              <span className="flex shrink-0 items-center pl-1 touch:min-h-11">
                <Switch checked={skill.enabled} disabled={!skill.user_disableable || Boolean(state)} onChange={(enabled) => void toggle(skill, enabled)}
                  label={w(`Use ${skill.name}`, `使用 ${skill.name}`, `使用 ${skill.name}`)} />
              </span>
            </li>;
          })}
        </SkillGroup>
      )))}

    {opened && openedActions && (
      <SkillSheet skill={opened} onClose={() => setOpenKey(null)} footer={openedActions.update || openedActions.remove ? <>
        {openedActions.remove && <Button size="sm" className={`mr-auto touch:h-11 touch:px-4 ${DANGER_BUTTON}`} disabled={Boolean(busy[opened.key])}
          onClick={() => { setDeleteError(""); setDeleting(opened); }}>{w("Delete skill", "删除技能", "刪除技能")}</Button>}
        {openedActions.update && <Button size="sm" variant="secondary" className="touch:h-11 touch:px-4" disabled={Boolean(busy[opened.key])} aria-busy={busy[opened.key] === "update" || undefined}
          onClick={() => void update(opened)}>{busy[opened.key] === "update" ? w("Updating…", "正在更新…", "正在更新…") : w("Update from link", "从链接更新", "從連結更新")}</Button>}
      </> : undefined}>
        {/* The sheet covers the page's notice, so its own actions report here. */}
        {outcome && <Notice tone={outcome.tone} title={outcome.text} onDismiss={() => setOutcome(null)} />}
      </SkillSheet>
    )}
    <InstallDialog open={installing} onClose={() => setInstalling(false)} endpoint="/api/skills"
      note={w("You can also paste a link or install instructions into your personal AI and ask it to install the skill.", "也可以把链接或安装说明发给个人 AI，让它帮你安装。", "也可以把連結或安裝說明傳給個人 AI，讓它幫你安裝。")}
      onInstalled={(skill) => {
        void list.reload(true);
        setOutcome({ tone: "success", text: w(`${skill.name} is installed. Your AI can use it from the next message.`, `已安装 ${skill.name}，AI 从下一条消息起可以使用。`, `已安裝 ${skill.name}，AI 從下一則訊息起可以使用。`) });
      }} />
    <ConfirmDialog
      open={deleting !== null}
      tone="danger"
      title={w(`Delete ${deleting?.name ?? ""}?`, `删除 ${deleting?.name ?? ""}？`, `刪除 ${deleting?.name ?? ""}？`)}
      description={w("Its files are removed from your personal workspace and your AI stops using it from the next message. This cannot be undone.", "这个技能的文件会从你的个人工作区删除，AI 从下一条消息起不再使用它。删除后无法恢复。", "這個技能的檔案會從你的個人工作區刪除，AI 從下一則訊息起不再使用它。刪除後無法復原。")}
      confirmLabel={w("Delete skill", "删除技能", "刪除技能")}
      busy={deleting !== null && busy[deleting.key] === "delete"}
      error={deleteError || undefined}
      onConfirm={() => { if (deleting) void remove(deleting); }}
      onCancel={() => setDeleting(null)}
    />
  </div>;
}

function SkillGroup({ title, hint, count, empty, children }: { title: string; hint: string; count: number; empty: ReactNode; children: ReactNode }) {
  const id = useId();
  return <section aria-labelledby={id} className="flex flex-col gap-2">
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1">
      <h2 id={id} className="text-[13px] font-medium text-ink">{title}</h2>
      <span className="text-[12px] text-ink-2 tabular-nums">{count}</span>
      <p className="basis-full text-[12px] leading-[1.4] text-ink-2 sm:basis-auto sm:ml-auto">{hint}</p>
    </div>
    {count > 0
      ? <ul className="flex flex-col overflow-hidden rounded-card bg-surface shadow-card">{children}</ul>
      : <div className="rounded-card bg-surface px-4 py-3 text-[12.5px] text-ink-2 shadow-card">{empty}</div>}
  </section>;
}
