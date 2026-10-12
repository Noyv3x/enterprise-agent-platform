export interface User {
  id: number;
  username: string;
  display_name: string;
  role: string;
  position: string;
  permission_group: string;
  timezone: string;
  active: boolean;
  language?: string;
  [key: string]: unknown;
}

/** The administrator view of an account; users never receive their model policy group. */
export interface AdminUser extends User {
  model_policy: string;
}

/** A failed request: the server's `error` text, its HTTP status, and its typed `code` with any extra fields
 * (`candidates` for an ambiguous skill package, for example). */
export class ApiError extends Error {
  constructor(message: string, public status: number, public code = '', public details: Record<string, unknown> = {}) { super(message); }
}

export type SkillTier = 'builtin' | 'org' | 'personal' | 'channel';
export type SkillSourceKind = 'upload' | 'url' | 'workspace' | 'ai' | 'migrated';

/** One skill as the user API shows it (platform-api.md § Skills). `key` is `builtin:<n>`, `org:<n>`,
 * `personal:<n>` or `channel:<id>:<n>`. */
export interface SkillView {
  key: string;
  name: string;
  description: string;
  tier: SkillTier;
  version: string | null;
  source: { kind: SkillSourceKind; url?: string } | null;
  enabled: boolean;
  user_disableable: boolean;
  manageable: boolean;
  updated_at: string | null;
  warnings: string[];
}

/** `GET /api/skills?scope=…` */
export interface SkillList { skills: SkillView[]; can_install: boolean }

/** `GET /api/skills/{key}`: SKILL.md text and the package's files. */
export interface SkillDetail { skill: SkillView; content: string; files: { path: string; size_bytes: number }[] }

/** `GET /api/admin/skills` */
export interface OrgSkill extends SkillView { groups: string[] }
export interface BuiltinSkill extends SkillView { org_enabled: boolean }
export interface AdminSkills { org: OrgSkill[]; builtin: BuiltinSkill[]; groups: string[] }

/** What an artifact (作品) shows as, derived from its entry extension (platform-api.md § Artifacts). */
export type ArtifactKind = 'web' | 'site' | 'markdown' | 'mermaid' | 'svg' | 'table' | 'code' | 'image' | 'pdf';

/** One artifact of a conversation scope. `scope` is the `?scope=` form; `entry` is the latest version's entry relpath. */
export interface ArtifactView {
  id: number;
  scope: string;
  path: string;
  kind: ArtifactKind;
  title: string;
  entry: string;
  latest_version: number;
  created_at: string;
  updated_at: string;
}

/** `GET /api/artifacts/{id}`: one version (newest first); `message_id` is null until the reply is persisted. */
export interface ArtifactVersion {
  version: number;
  entry: string;
  created_at: string;
  total_size: number;
  file_count: number;
  message_id: number | null;
}

/** `GET /api/artifacts/{id}/versions/{v}/files` */
export interface ArtifactFile { path: string; size: number; mime: string }

/** `GET /api/artifacts/{id}/versions/{v}/source?path=`: text only, at most 2 MB. */
export interface ArtifactSource { content: string; truncated: boolean; mime: string }

/** `metadata.artifacts[]` of the assistant message whose run published that version. */
export interface ArtifactRef { id: number; version: number; title: string; kind: ArtifactKind; path: string }

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  if (response.status === 401) window.dispatchEvent(new Event('session-expired'));
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as ({ error?: string; code?: string } & Record<string, unknown>) | null;
    const { error, code, ...details } = payload ?? {};
    throw new ApiError(error || `${response.status} ${response.statusText}`, response.status, typeof code === 'string' ? code : '', details);
  }
  return response.json() as Promise<T>;
}
