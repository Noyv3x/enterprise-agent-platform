import { redactCommandForApproval } from "./approval-policy.js";
import type { JsonObject } from "./types.js";

const LEGACY_ACTION_ENVELOPE_TOOLS = new Set([
  "process",
  "memory",
  "skill",
  "browser",
  "schedule",
  "mail",
  "sylver_platform",
]);

const UNKNOWN_SCHEMA_MAX_DEPTH = 6;
const UNKNOWN_SCHEMA_MAX_ITEMS = 50;
const UNKNOWN_SCHEMA_MAX_NODES = 256;
const UNKNOWN_SCHEMA_MAX_STRING_BYTES = 2_048;
const MODEL_ARGUMENT_MAX_DEPTH = 12;
const MODEL_ARGUMENT_MAX_ITEMS = 100;
const MODEL_ARGUMENT_MAX_NODES = 2_000;

/**
 * Build the durable, model-facing copy of tool arguments.
 *
 * Unlike the audit journal projection, this representation must remain shaped
 * like the tool's executable schema because the model sees it again as a
 * protocol example on the next turn.
 */
export function redactToolArgumentsForModelHistory(
  toolName: string,
  args: JsonObject,
  _workspace?: string,
): JsonObject {
  const canonical = canonicalModelArguments(toolName, args);

  if (toolName === "terminal") {
    return replaceString(canonical, "command", "command");
  }
  if (toolName === "process") {
    return replaceString(canonical, "input", "input");
  }
  if (toolName === "write_file") {
    const redacted = { ...canonical };
    if (typeof canonical.content === "string") {
      redacted.content = omittedValue("content", canonical.content);
    } else if (!Object.hasOwn(canonical, "content")) {
      redacted.content = omittedValue("content");
    }
    return redacted;
  }
  if (toolName === "patch_file") {
    const redacted = { ...canonical };
    if (typeof canonical.old_text === "string") {
      redacted.old_text = omittedValue("old_text", canonical.old_text);
    } else if (!Object.hasOwn(canonical, "old_text")) {
      redacted.old_text = omittedValue("old_text");
    }
    if (typeof canonical.new_text === "string") {
      redacted.new_text = omittedValue("new_text", canonical.new_text);
    } else if (!Object.hasOwn(canonical, "new_text")) {
      redacted.new_text = omittedValue("new_text");
    }
    return redacted;
  }
  if (toolName === "search_files") {
    return replaceString(canonical, "query", "query");
  }
  if (toolName === "delegate_task") {
    if (Array.isArray(canonical.tasks)) {
      return {
        ...canonical,
        tasks: canonical.tasks.map((task) => {
          if (!isObject(task)) return omittedValue("delegated task");
          const redactedTask = { ...task };
          if (typeof task.prompt === "string") {
            redactedTask.prompt = omittedValue("delegated prompt", task.prompt);
          }
          return redactedTask;
        }),
      };
    }
    const redacted = { ...canonical };
    if (typeof canonical.prompt === "string") {
      redacted.prompt = omittedValue("delegated prompt", canonical.prompt);
    }
    return redacted;
  }

  const redacted = { ...canonical };
  const action = typeof canonical.action === "string" ? canonical.action : "";
  if (isObject(canonical.arguments)) {
    const originalArguments = canonical.arguments;
    const projectionSource = { ...originalArguments };
    const omittedFields = omittedActionFields(toolName, action);
    for (const [field, label] of omittedFields) {
      const value = originalArguments[field];
      if (typeof value === "string") projectionSource[field] = omittedValue(label, value);
    }
    const browserSchema = toolName === "browser" && isObject(originalArguments.schema)
      ? originalArguments.schema
      : undefined;
    if (browserSchema) delete projectionSource.schema;
    const projected = redactFlexibleValue(
      projectionSource,
      0,
      { remaining: MODEL_ARGUMENT_MAX_NODES },
    );
    const nested = isObject(projected) ? projected : {};
    restoreConstrainedFields(toolName, originalArguments, nested);
    if (toolName === "browser") {
      if (browserSchema) nested.schema = boundedUnknownSchema(browserSchema);
    }
    redacted.arguments = nested;
  }
  return redacted;
}

/**
 * Current Runtime releases briefly persisted approval-display envelopes in
 * model history. Collapse only the exact, matching tool discriminator. Any
 * mismatched discriminator or unrelated field survives and therefore remains
 * invalid under the strict executable schema.
 */
function canonicalModelArguments(toolName: string, args: JsonObject): JsonObject {
  if (!LEGACY_ACTION_ENVELOPE_TOOLS.has(toolName) || args.tool !== toolName) {
    return { ...args };
  }

  const withoutTool = { ...args };
  delete withoutTool.tool;
  if (toolName !== "process") return withoutTool;

  if (!isObject(withoutTool.arguments)) {
    return withoutTool;
  }
  const nested = withoutTool.arguments;
  const { arguments: _arguments, ...root } = withoutTool;
  // Root action is authoritative. Unknown nested/root fields are intentionally
  // retained so strict validation can continue to reject them.
  return { ...nested, ...root };
}

function omittedActionFields(toolName: string, action: string): ReadonlyArray<readonly [string, string]> {
  if (toolName === "browser" && action === "type") return [["text", "input"]];
  if (toolName === "memory" && ["store", "replace"].includes(action)) return [["content", "content"]];
  if (toolName === "skill" && ["create", "update"].includes(action)) return [["instructions", "instructions"]];
  if (toolName === "skill" && action === "write_file") return [["content", "content"]];
  if (toolName === "schedule" && ["create", "update"].includes(action)) return [["prompt", "prompt"]];
  if (toolName === "mail" && ["send", "reply"].includes(action)) {
    return [["text_body", "text_body"], ["html_body", "html_body"]];
  }
  if (toolName === "sylver_platform") {
    if (action === "create_task") return [["description", "description"]];
    if (action === "start_task") return [["note", "note"]];
    if (action === "add_task_activity") return [["detail", "detail"]];
    if (action === "propose_wiki") {
      return [
        ["content", "content"],
        ["change_summary", "change_summary"],
        ["discussion_ref", "discussion_ref"],
      ];
    }
    if (action === "comment_approval") return [["body", "body"]];
  }
  return [];
}

function replaceString(value: JsonObject, field: string, label: string): JsonObject {
  const result = { ...value };
  if (typeof value[field] === "string") {
    result[field] = redactFreeText(value[field], label);
  }
  return result;
}

function redactFreeText(value: string, label: string): string {
  if (isOmittedValue(value)) return value;
  const redacted = redactCommandForApproval(value);
  return redacted || (value ? omittedValue(label, value) : "");
}

function redactFlexibleValue(
  value: unknown,
  depth: number,
  budget: { remaining: number },
): unknown {
  if (budget.remaining <= 0 || depth > MODEL_ARGUMENT_MAX_DEPTH) return "[omitted]";
  budget.remaining -= 1;
  if (typeof value === "string") return redactFreeText(value, "value");
  if (Array.isArray(value)) {
    return value.slice(0, MODEL_ARGUMENT_MAX_ITEMS)
      .map((item) => redactFlexibleValue(item, depth + 1, budget));
  }
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, MODEL_ARGUMENT_MAX_ITEMS)
      .map(([key, item]) => [key, redactFlexibleValue(item, depth + 1, budget)]),
  );
}

function restoreConstrainedFields(
  toolName: string,
  original: JsonObject,
  projected: JsonObject,
): void {
  if (toolName === "skill") {
    if (typeof original.id === "string") {
      projected.id = redactCommandForApproval(original.id) === original.id
        ? original.id
        : "redacted";
    }
    if (typeof original.file_path === "string") {
      const category = original.file_path.split("/", 1)[0] || "references";
      projected.file_path = redactCommandForApproval(original.file_path) === original.file_path
        ? original.file_path
        : `${category}/redacted`;
    }
  }
  if (toolName === "web" && typeof original.language === "string") {
    projected.language = original.language;
  }
  if (toolName === "mail") {
    if (typeof original.state === "string") projected.state = original.state;
    const originalCriteria = isObject(original.criteria) ? original.criteria : undefined;
    const projectedCriteria = isObject(projected.criteria) ? projected.criteria : undefined;
    if (originalCriteria && projectedCriteria) {
      for (const field of ["since", "before"] as const) {
        if (typeof originalCriteria[field] === "string") {
          projectedCriteria[field] = originalCriteria[field];
        }
      }
    }
  }
  if (toolName === "schedule") {
    if (typeof original.delivery === "string") projected.delivery = original.delivery;
    const originalSchedule = isObject(original.schedule) ? original.schedule : undefined;
    const projectedSchedule = isObject(projected.schedule) ? projected.schedule : undefined;
    if (originalSchedule && projectedSchedule) {
      for (const field of ["type", "at", "starts_at", "expression"] as const) {
        if (typeof originalSchedule[field] === "string") {
          projectedSchedule[field] = originalSchedule[field];
        }
      }
    }
  }
}

function boundedUnknownSchema(value: JsonObject): JsonObject {
  const budget = { remaining: UNKNOWN_SCHEMA_MAX_NODES };
  const bounded = boundedUnknownValue(value, 0, budget);
  return isObject(bounded) ? bounded : {};
}

function boundedUnknownValue(
  value: unknown,
  depth: number,
  budget: { remaining: number },
): unknown {
  if (budget.remaining <= 0 || depth > UNKNOWN_SCHEMA_MAX_DEPTH) return "[omitted]";
  budget.remaining -= 1;
  if (Array.isArray(value)) {
    return value.slice(0, UNKNOWN_SCHEMA_MAX_ITEMS)
      .map((item) => boundedUnknownValue(item, depth + 1, budget));
  }
  if (typeof value === "string") {
    return boundedUtf8(redactFreeText(value, "schema value"), UNKNOWN_SCHEMA_MAX_STRING_BYTES);
  }
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, UNKNOWN_SCHEMA_MAX_ITEMS)
      .map(([key, item]) => [key, boundedUnknownValue(item, depth + 1, budget)]),
  );
}

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "[truncated]";
  const target = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > target) break;
    result += character;
    bytes += width;
  }
  return `${result}${suffix}`;
}

function omittedValue(label: string, value?: string): string {
  if (isOmittedValue(value)) return value;
  if (value === undefined) return `[${label} omitted from older durable history]`;
  return `[${label} omitted: ${Buffer.byteLength(value, "utf8")} UTF-8 bytes]`;
}

function isOmittedValue(value: unknown): value is string {
  return typeof value === "string"
    && /^\[[^\]\r\n]{1,200}\]$/.test(value)
    && /\bomitted\b/i.test(value);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
