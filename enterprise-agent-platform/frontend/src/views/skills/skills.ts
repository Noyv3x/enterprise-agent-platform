import { ApiError, type SkillView } from "../../api";
import type { RecordTagValue } from "../../components/ui/beautiful/primitives/RecordsTable";
import { useWords } from "../../words";

/** A skill's user API path (keys contain `:`). */
export function skillPath(key: string): string {
  return `/api/skills/${encodeURIComponent(key)}`;
}

/** SKILL.md without its YAML frontmatter (the sheet shows those fields itself). */
export function skillBody(content: string): string {
  const match = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  return match ? content.slice(match[0].length) : content;
}

/** The search used by Settings → Skills and Admin → Skills: name or description contains the lowercased needle. */
export function matches(skill: SkillView, needle: string): boolean {
  return !needle || skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle);
}

/** Labels shared by Settings → Skills, Admin → Skills and the detail sheet. */
export function useSkillLabels() {
  const w = useWords();
  const sources: Record<string, RecordTagValue> = {
    builtin: { key: "builtin", label: w("Built-in", "内置", "內建"), hue: "neutral" },
    org: { key: "org", label: w("Organization", "组织", "組織"), hue: "green" },
    upload: { key: "upload", label: w("Uploaded", "上传", "上傳"), hue: "amber" },
    url: { key: "url", label: w("Link", "链接", "連結"), hue: "purple" },
    ai: { key: "ai", label: w("Created by AI", "AI 创建", "AI 建立"), hue: "pink" },
    migrated: { key: "migrated", label: w("Migrated", "已迁移", "已遷移"), hue: "yellow" },
    workspace: { key: "workspace", label: w("Workspace", "工作区", "工作區"), hue: "neutral" },
  };
  return {
    /** Built-in and organization skills read by tier; personal and channel skills by how they arrived. */
    tag: (skill: SkillView): RecordTagValue =>
      skill.tier === "builtin" || skill.tier === "org" ? sources[skill.tier] : sources[skill.source?.kind ?? "workspace"] ?? sources.workspace,
    /** How an organization skill arrived (upload or link). */
    source: (skill: SkillView): RecordTagValue | null => (skill.source ? sources[skill.source.kind] ?? null : null),
    version: (skill: SkillView) => (skill.version ? `v${skill.version.replace(/^v/i, "")}` : ""),
    warnings: (count: number) => w(`${count} ${count === 1 ? "warning" : "warnings"}`, `${count} 个警告`, `${count} 個警告`),
    /** Why updating `name` from its link failed. `skill_update_renamed` (409, `new_name`): the package at the link now
     * has another name, so Platform refuses the update and keeps the installed skill. */
    updateFailure: (name: string, cause: unknown): string => {
      if (!(cause instanceof ApiError) || cause.code !== "skill_update_renamed") return cause instanceof Error ? cause.message : String(cause);
      const renamed = typeof cause.details.new_name === "string" ? cause.details.new_name : "";
      return renamed
        ? w(`${name} was not updated: the skill at its link is now named “${renamed}”. Install it from the link as a new skill; ${name} stays as it is.`,
          `${name} 未更新：链接里的技能已改名为“${renamed}”。请用这个链接把它作为新技能安装；${name} 保持不变。`,
          `${name} 未更新：連結裡的技能已改名為「${renamed}」。請用這個連結把它當作新技能安裝；${name} 保持不變。`)
        : w(`${name} was not updated: the skill at its link now has a different name. Install it from the link as a new skill; ${name} stays as it is.`,
          `${name} 未更新：链接里的技能已经改了名字。请用这个链接把它作为新技能安装；${name} 保持不变。`,
          `${name} 未更新：連結裡的技能已經改了名字。請用這個連結把它當作新技能安裝；${name} 保持不變。`);
    },
  };
}
