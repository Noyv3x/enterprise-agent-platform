import type { McpAdminConnector, McpAuth, McpConnectorView, McpCredentialMode } from "../../api";
import { newSecretRow, secretRowsError, type SecretRow } from "./SecretFields";

/** Connector names are slugs, unique per owner (platform-api.md § MCP). */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const REMOTE_URL = /^https?:\/\/[^\s/?#@]+[^\s]*$/i;

export type ConnectorKind = "remote" | "local";

/** The connector form's state. "Automatic" is Streamable HTTP (`http`), whose protocol version the platform
 * negotiates; only a legacy server needs `sse`. Arguments are one per line, so they may contain spaces. */
export interface ConnectorDraft {
  name: string;
  label: string;
  kind: ConnectorKind;
  url: string;
  transport: "http" | "sse";
  auth: McpAuth;
  headers: SecretRow[];
  command: string;
  args: string;
  cwd: string;
  env: SecretRow[];
  enabled: boolean;
  credentialMode: McpCredentialMode;
  groups: string[];
  clientId: string;
  clientSecret: string;
  clientSecretSet: boolean;
  scopes: string;
}

const rowsFrom = (keys: string[], set: Record<string, boolean>) => keys.map((key) => newSecretRow(key, true, Boolean(set[key])));

export function draftFrom(connector?: McpConnectorView | McpAdminConnector, defaults: Partial<ConnectorDraft> = {}): ConnectorDraft {
  const oauth = connector && "oauth" in connector ? connector.oauth : null;
  return {
    name: connector?.name ?? "",
    label: connector?.label ?? "",
    kind: connector?.transport === "stdio" ? "local" : "remote",
    url: connector?.url ?? "",
    transport: connector?.transport === "sse" ? "sse" : "http",
    auth: connector?.auth ?? "none",
    headers: connector ? rowsFrom(connector.header_keys, connector.secrets_set) : [],
    command: connector?.command ?? "",
    args: (connector?.args ?? []).join("\n"),
    cwd: connector?.cwd ?? "",
    env: connector ? rowsFrom(connector.env_keys, connector.secrets_set) : [],
    enabled: connector?.enabled ?? true,
    credentialMode: connector?.credential_mode ?? "per_user",
    groups: connector?.groups ?? ["*"],
    clientId: oauth?.client_id ?? "",
    clientSecret: "",
    clientSecretSet: oauth?.client_secret_set ?? false,
    scopes: (oauth?.scopes ?? []).join(" "),
    ...defaults,
  };
}

export interface DraftProblems { name?: "invalid" | "taken"; url?: boolean; command?: boolean; headers?: string; env?: string; groups?: boolean }

/** What blocks saving; `takenNames` are the owner's other connector names. */
export function draftProblems(draft: ConnectorDraft, takenNames: string[], admin: boolean): DraftProblems {
  const problems: DraftProblems = {};
  const name = draft.name.trim();
  if (!NAME_PATTERN.test(name)) problems.name = "invalid";
  else if (takenNames.includes(name)) problems.name = "taken";
  if (draft.kind === "remote" && !REMOTE_URL.test(draft.url.trim())) problems.url = true;
  if (draft.kind === "local" && !draft.command.trim()) problems.command = true;
  if (draft.kind === "remote" && draft.auth === "headers") {
    const headers = draft.headers.filter((row) => row.stored || row.key.trim());
    problems.headers = headers.length === 0 ? "empty" : secretRowsError(headers, "header") || undefined;
  }
  if (draft.kind === "local") problems.env = secretRowsError(draft.env, "env") || undefined;
  if (admin && draft.groups.length === 0) problems.groups = true;
  return Object.fromEntries(Object.entries(problems).filter(([, value]) => value !== undefined)) as DraftProblems;
}

const filled = (rows: SecretRow[]) => rows.filter((row) => row.stored || row.key.trim());

/** `{KEY: value}`, an empty value declaring a key whose value is still missing. */
function valuesOf(rows: SecretRow[], withValues: boolean): Record<string, string> {
  return Object.fromEntries(filled(rows).map((row) => [row.key.trim(), withValues ? row.value : ""]));
}

/** Whether this form writes secret values: the user's own connector, or a shared organization one. Per-user
 * organization connectors declare only key names; each user fills in their own values. */
export function writesValues(draft: ConnectorDraft, admin: boolean): boolean {
  return !admin || draft.credentialMode === "shared";
}

function adminFields(draft: ConnectorDraft, original?: McpAdminConnector) {
  const oauth = draft.kind === "remote" && draft.auth === "oauth";
  const clientId = draft.clientId.trim();
  // Without authentication there is nothing per user: everyone shares the one connection, so channels may use it.
  const fields: Record<string, unknown> = { credential_mode: draft.auth === "none" ? "shared" : draft.credentialMode, groups: draft.groups };
  if (oauth) {
    fields.oauth_scopes = draft.scopes.split(/[\s,]+/).filter(Boolean);
    if (clientId) fields.oauth_client = { client_id: clientId, ...(draft.clientSecret ? { client_secret: draft.clientSecret } : {}) };
    else if (original?.oauth?.client_id) fields.oauth_client = null;
  }
  return fields;
}

/** `POST …/connectors`. Secret values ride in `headers`/`env` and are stored as secrets. */
export function createBody(draft: ConnectorDraft, admin: boolean): Record<string, unknown> {
  const values = writesValues(draft, admin);
  const common = { name: draft.name.trim(), label: draft.label.trim() || draft.name.trim(), enabled: draft.enabled, ...(admin ? adminFields(draft) : {}) };
  if (draft.kind === "local") {
    return { ...common, transport: "stdio", command: draft.command.trim(), args: argsOf(draft), cwd: draft.cwd.trim() || null, auth: "none", env: valuesOf(draft.env, true) };
  }
  return { ...common, transport: draft.transport, url: draft.url.trim(), auth: draft.auth, ...(draft.auth === "headers" ? { headers: valuesOf(draft.headers, values) } : {}) };
}

function argsOf(draft: ConnectorDraft): string[] {
  return draft.args.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** `PATCH …/connectors/{id}`: the changed definition, the key lists, and `secrets` with only the values typed now
 * (`null` for a stored key that was removed). */
export function patchBody(draft: ConnectorDraft, original: McpConnectorView | McpAdminConnector, admin: boolean): Record<string, unknown> {
  const values = writesValues(draft, admin);
  const body: Record<string, unknown> = { label: draft.label.trim() || original.name, enabled: draft.enabled };
  const rows = draft.kind === "local" ? filled(draft.env) : draft.auth === "headers" ? filled(draft.headers) : [];
  const keys = rows.map((row) => row.key.trim());
  const previous = [...original.header_keys, ...original.env_keys];
  const secrets: Record<string, string | null> = {};
  for (const key of previous) if (!keys.includes(key) && original.secrets_set[key]) secrets[key] = null;
  if (values) for (const row of rows) if (row.value) secrets[row.key.trim()] = row.value;
  if (draft.kind === "local") {
    Object.assign(body, { command: draft.command.trim(), args: argsOf(draft), cwd: draft.cwd.trim() || null, env_keys: keys, header_keys: [] });
  } else {
    Object.assign(body, { transport: draft.transport, url: draft.url.trim(), auth: draft.auth, header_keys: keys, env_keys: [] });
  }
  if (Object.keys(secrets).length) body.secrets = secrets;
  if (admin) Object.assign(body, adminFields(draft, original as McpAdminConnector));
  return body;
}
