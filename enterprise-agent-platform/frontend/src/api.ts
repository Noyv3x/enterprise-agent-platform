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

export type McpTransport = 'http' | 'sse' | 'stdio';
export type McpAuth = 'none' | 'headers' | 'oauth';
export type McpCredentialMode = 'shared' | 'per_user';
/** `pending_confirmation`: added by the AI or by an import, and unusable until the user confirms it (POST …/confirm). */
export type McpStatus = 'connected' | 'needs_auth' | 'needs_secrets' | 'error' | 'idle' | 'pending_confirmation';

/** One MCP connector (连接器) as Platform shows it (platform-api.md § MCP). Secret values never leave Platform:
 * `secrets_set` only says which header/env keys hold a value for the credential owner (the caller, or the
 * organization for a shared connector). `source` is `manual`, `ai`, `import:<format>` or `legacy`. */
export interface McpConnectorView {
  id: number;
  scope: 'org' | 'personal';
  name: string;
  label: string;
  transport: McpTransport;
  url?: string | null;
  command?: string | null;
  args?: string[];
  cwd?: string | null;
  header_keys: string[];
  env_keys: string[];
  auth: McpAuth;
  credential_mode: McpCredentialMode;
  enabled: boolean;
  disabled_tools: string[];
  status: McpStatus;
  last_error?: string | null;
  secrets_set: Record<string, boolean>;
  groups?: string[];
  tool_count?: number | null;
  timeout_s?: number | null;
  source: string;
  manageable: boolean;
  oauth_warning?: 'https_required' | null;
}

/** `GET /api/mcp/connectors?scope=private|chat` */
export interface McpConnectorList { connectors: McpConnectorView[]; can_install: boolean; oauth_warning?: 'https_required' | null }

/** `GET /api/admin/mcp/connectors`: `oauth` is the scopes and any pre-registered client (its secret only as set or not). */
export interface McpAdminConnector extends McpConnectorView {
  groups: string[];
  oauth?: { scopes: string[]; client_id: string | null; client_secret_set: boolean } | null;
}
/** `oauth_redirect_uri` is the callback address to register with a provider for a pre-registered client. */
export interface McpAdminConnectors { connectors: McpAdminConnector[]; groups: string[]; oauth_warning?: 'https_required' | null; oauth_redirect_uri?: string | null }

export interface McpToolView { name: string; description?: string | null; read_only: boolean; enabled: boolean }
/** `GET …/connectors/{id}/catalog` */
export interface McpCatalog {
  tools: McpToolView[];
  prompts: { name: string; title?: string | null; description?: string | null }[];
  resources: { uri: string; name?: string | null; description?: string | null }[];
}
/** `POST …/connectors/{id}/test` */
export interface McpTestResult { ok: boolean; server?: { name: string; version?: string | null } | null; tools: number; error?: string | null }

/** `GET /api/mcp/import/detected`: foreign config files found in the personal workspace. */
export interface McpDetectedFile { path: string; format: string; servers: string[] }
/** What an import or `mcp add` still needs from the user (OAuth sign-in, or secret values). `connector` is the name. */
export interface McpMissing { connector: string; kind: 'oauth' | 'secrets'; keys?: string[] }
/** A foreign entry that was not imported: `reason` is `exists`, `local_not_allowed` or another code with `message`. */
export interface McpSkipped { name: string; reason: string; message?: string | null }
export interface McpImportResult { connectors: McpConnectorView[]; missing: McpMissing[]; skipped?: (McpSkipped | string)[] }

/** `GET /api/admin/mcp/calls`: one audited tool call; never its content. */
export interface McpCallRow {
  id: number;
  /** epoch seconds */
  at: number;
  user_id: number | null;
  username?: string | null;
  display_name?: string | null;
  scope_key: string;
  connector_id: number | null;
  connector_name?: string | null;
  connector_label?: string | null;
  tool: string;
  status: 'ok' | 'error' | 'cancelled' | 'timeout';
  duration_ms: number;
}

/** A channel manager's reduced view of a connector: `origin` is the server URL's origin only, without its path. */
export interface McpChannelConnector extends Pick<McpConnectorView, 'id' | 'name' | 'label' | 'transport' | 'auth' | 'enabled' | 'status'> { scope: 'org'; origin: string }
/** `GET /api/channels/{id}/mcp`: the shared organization connectors the channel may use, and those it does. */
export interface McpChannelConnectors { connectors: McpChannelConnector[]; connector_ids: number[] }

export interface McpPromptArgument { name: string; description?: string | null; required?: boolean }
/** `GET /api/mcp/prompts?scope=`: offered in the composer as `/<connector>:<name>`. */
export interface McpPrompt { connector: string; connector_label: string; name: string; title?: string | null; description?: string | null; arguments: McpPromptArgument[] }
/** `connectors` is every connector available in the scope (the trace labels use it). */
export interface McpPromptList { prompts: McpPrompt[]; connectors: { name: string; label: string }[] }
/** `POST /api/mcp/prompts/render` */
export interface McpPromptRender { text: string }

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
