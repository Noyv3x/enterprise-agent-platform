import type { Words } from "./work";

/** One field of an MCP elicitation form. The spec limits requested schemas to a flat object of primitives: strings
 * (optionally email, uri, date or date-time), numbers, integers, booleans, single-select enums (`enum` with optional
 * `enumNames`, or `oneOf` of `{const, title}`) and multi-select arrays of such enums. */
export type SchemaField = {
  key: string;
  title: string;
  description: string;
  required: boolean;
} & (
  | { kind: "string"; format: "email" | "uri" | "date" | "date-time" | null; minLength: number | null; maxLength: number | null; initial: string }
  | { kind: "number" | "integer"; minimum: number | null; maximum: number | null; initial: string }
  | { kind: "boolean"; initial: boolean }
  | { kind: "enum"; options: { value: string; label: string }[]; initial: string }
  | { kind: "multi"; options: { value: string; label: string }[]; minItems: number | null; maxItems: number | null; initial: string[] }
);

/** What the form holds while it is edited: text for strings and numbers, booleans, chosen enum values. */
export type FormValues = Record<string, string | boolean | string[]>;

export interface ParsedSchema {
  fields: SchemaField[];
  /** properties this form cannot render (nested objects, untyped); a required one means it can only be declined */
  unsupported: { key: string; required: boolean }[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Choices of a single-select schema (`enum` [+ `enumNames`] or `oneOf`/`anyOf` of `{const, title}`); null if none. */
function choices(schema: Record<string, unknown>): { value: string; label: string }[] | null {
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.flatMap((value, index) => (typeof value === "string" ? [{ value, label: str(names[index]) || value }] : []));
  }
  const titled = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : null;
  if (!titled) return null;
  return titled.flatMap((entry) => {
    const option = record(entry);
    return option && typeof option.const === "string" ? [{ value: option.const, label: str(option.title) || option.const }] : [];
  });
}

const FORMATS = { email: true, uri: true, date: true, "date-time": true } as const;

/** Reads a requested schema as is: unknown keywords are ignored, never interpreted. */
export function parseSchema(schema: unknown): ParsedSchema {
  const root = record(schema);
  const properties = record(root?.properties) ?? {};
  const required = new Set(Array.isArray(root?.required) ? root.required.filter((key): key is string => typeof key === "string") : []);
  const fields: SchemaField[] = [];
  const unsupported: ParsedSchema["unsupported"] = [];
  for (const [key, raw] of Object.entries(properties)) {
    const property = record(raw);
    const base = { key, title: str(property?.title) || key, description: str(property?.description), required: required.has(key) };
    const options = property ? choices(property) : null;
    if (property?.type === "array") {
      const items = record(property.items);
      const multi = items ? choices(items) : null;
      if (multi) {
        const initial = Array.isArray(property.default) ? property.default.filter((value): value is string => multi.some((option) => option.value === value)) : [];
        fields.push({ ...base, kind: "multi", options: multi, minItems: num(property.minItems), maxItems: num(property.maxItems), initial });
        continue;
      }
    } else if (options && (property?.type === "string" || property?.type === undefined)) {
      const initial = str(property?.default);
      fields.push({ ...base, kind: "enum", options, initial: options.some((option) => option.value === initial) ? initial : "" });
      continue;
    } else if (property?.type === "string") {
      const format = str(property.format);
      fields.push({
        ...base, kind: "string", format: format in FORMATS ? (format as keyof typeof FORMATS) : null,
        minLength: num(property.minLength), maxLength: num(property.maxLength), initial: str(property.default),
      });
      continue;
    } else if (property?.type === "number" || property?.type === "integer") {
      const initial = num(property.default);
      fields.push({ ...base, kind: property.type, minimum: num(property.minimum), maximum: num(property.maximum), initial: initial === null ? "" : String(initial) });
      continue;
    } else if (property?.type === "boolean") {
      fields.push({ ...base, kind: "boolean", initial: property.default === true });
      continue;
    }
    unsupported.push({ key, required: base.required });
  }
  return { fields, unsupported };
}

export function initialValues(fields: SchemaField[]): FormValues {
  return Object.fromEntries(fields.map((field) => [field.key, field.initial]));
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validUri(text: string): boolean {
  try {
    return Boolean(new URL(text).protocol);
  } catch {
    return false;
  }
}

/** Checks the values against the schema and builds the `content` to send: typed values, empty optional fields
 * left out. Returns the first problem per field instead when any field is invalid. */
export function formContent(fields: SchemaField[], values: FormValues, w: Words):
  | { ok: true; content: Record<string, string | number | boolean | string[]> }
  | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const content: Record<string, string | number | boolean | string[]> = {};
  const missing = w("Required", "必填", "必填");
  for (const field of fields) {
    const value = values[field.key];
    switch (field.kind) {
      case "boolean":
        content[field.key] = value === true;
        break;
      case "multi": {
        const chosen = Array.isArray(value) ? value : [];
        if (!chosen.length && !field.required) break;
        if (!chosen.length) errors[field.key] = missing;
        else if (field.minItems !== null && chosen.length < field.minItems) errors[field.key] = w(`Choose at least ${field.minItems}`, `至少选择 ${field.minItems} 项`, `至少選擇 ${field.minItems} 項`);
        else if (field.maxItems !== null && chosen.length > field.maxItems) errors[field.key] = w(`Choose at most ${field.maxItems}`, `最多选择 ${field.maxItems} 项`, `最多選擇 ${field.maxItems} 項`);
        else content[field.key] = chosen;
        break;
      }
      case "enum": {
        const chosen = typeof value === "string" ? value : "";
        if (chosen) content[field.key] = chosen;
        else if (field.required) errors[field.key] = missing;
        break;
      }
      case "number":
      case "integer": {
        const text = typeof value === "string" ? value.trim() : "";
        if (!text) {
          if (field.required) errors[field.key] = missing;
          break;
        }
        const parsed = Number(text);
        if (!Number.isFinite(parsed)) errors[field.key] = w("Enter a number", "请输入数字", "請輸入數字");
        else if (field.kind === "integer" && !Number.isInteger(parsed)) errors[field.key] = w("Enter a whole number", "请输入整数", "請輸入整數");
        else if (field.minimum !== null && parsed < field.minimum) errors[field.key] = w(`At least ${field.minimum}`, `不能小于 ${field.minimum}`, `不能小於 ${field.minimum}`);
        else if (field.maximum !== null && parsed > field.maximum) errors[field.key] = w(`At most ${field.maximum}`, `不能大于 ${field.maximum}`, `不能大於 ${field.maximum}`);
        else content[field.key] = parsed;
        break;
      }
      case "string": {
        const text = typeof value === "string" ? value : "";
        if (!text.trim()) {
          if (field.required) errors[field.key] = missing;
          break;
        }
        const length = [...text].length;
        if (field.minLength !== null && length < field.minLength) errors[field.key] = w(`At least ${field.minLength} characters`, `至少 ${field.minLength} 个字符`, `至少 ${field.minLength} 個字元`);
        else if (field.maxLength !== null && length > field.maxLength) errors[field.key] = w(`At most ${field.maxLength} characters`, `最多 ${field.maxLength} 个字符`, `最多 ${field.maxLength} 個字元`);
        else if (field.format === "email" && !EMAIL.test(text)) errors[field.key] = w("Enter an email address", "请输入有效的邮箱地址", "請輸入有效的電子郵件地址");
        else if (field.format === "uri" && !validUri(text)) errors[field.key] = w("Enter a full link, such as https://…", "请输入完整链接，例如 https://…", "請輸入完整連結，例如 https://…");
        else if (field.format === "date-time" && Number.isNaN(Date.parse(text))) errors[field.key] = w("Enter a date and time", "请输入日期和时间", "請輸入日期和時間");
        else content[field.key] = field.format === "date-time" ? new Date(text).toISOString() : text;
        break;
      }
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, content };
}
