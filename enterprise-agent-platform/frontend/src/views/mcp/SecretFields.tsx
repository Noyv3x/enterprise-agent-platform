import { useId } from "react";
import { Button } from "../../components/ui/beautiful/atoms/Button";
import { Field, Icon, TextField } from "../../components/ui/beautiful/controls";
import { useWords } from "../../words";

/* Secret values are write-only: Platform reports a key only as set or not set, so these inputs always start empty,
 * are password fields, and an empty input means "keep what is stored". */

const ICON_BUTTON = "flex size-9 shrink-0 items-center justify-center rounded-control text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-50 touch:size-11";

/** 已设置 / 未设置 next to a secret's name. */
export function SecretState({ set }: { set: boolean }) {
  const w = useWords();
  return set
    ? <span className="inline-flex items-center gap-1 text-[12px] font-normal text-green-ink"><Icon name="check" size={12} strokeWidth={2.2} />{w("Set", "已设置", "已設定")}</span>
    : <span className="text-[12px] font-normal text-ink-2">{w("Not set", "未设置", "未設定")}</span>;
}

/** One password input per fixed key (a connector's declared headers or environment variables). `values` holds only
 * what the user typed in this form. */
export function SecretFields({ keys, set, values, onChange, disabled = false }: {
  keys: string[];
  set: Record<string, boolean>;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  disabled?: boolean;
}) {
  const w = useWords();
  const id = useId();
  return <div className="flex flex-col gap-3">
    {keys.map((key, index) => (
      <Field key={key} id={`${id}-${index}`} label={<span className="inline-flex flex-wrap items-center gap-2"><span className="font-mono text-[12.5px]">{key}</span><SecretState set={Boolean(set[key])} /></span>}>
        <TextField type="password" autoComplete="new-password" spellCheck={false} disabled={disabled} value={values[key] ?? ""}
          placeholder={set[key] ? w("Leave empty to keep the saved value", "留空则保留已保存的值", "留空則保留已儲存的值") : w("Enter the value", "输入值", "輸入值")}
          onChange={(event) => onChange({ ...values, [key]: event.target.value })} />
      </Field>
    ))}
  </div>;
}

/** An editable key list with a write-only value per key: request headers or environment variables. `stored` rows
 * already exist on the connector (their name is fixed; `set` says whether a value is stored). */
export interface SecretRow { id: string; key: string; value: string; stored: boolean; set: boolean }

let rowSeq = 0;
export function newSecretRow(key = "", stored = false, set = false): SecretRow {
  rowSeq += 1;
  return { id: `secret-${rowSeq}`, key, value: "", stored, set };
}

export type SecretKind = "header" | "env";
const KEY_PATTERN: Record<SecretKind, RegExp> = { header: /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, env: /^[A-Za-z_][A-Za-z0-9_]*$/ };

/** The first problem with the rows' names, or ''. */
export function secretRowsError(rows: SecretRow[], kind: SecretKind): string {
  const names = rows.map((row) => row.key.trim()).filter(Boolean);
  if (names.some((name) => !KEY_PATTERN[kind].test(name))) return "invalid";
  const folded = names.map((name) => (kind === "header" ? name.toLowerCase() : name));
  return new Set(folded).size === folded.length ? "" : "duplicate";
}

/** `withValues: false` edits only the names (a per-user organization connector: each user fills in their own values). */
export function SecretRows({ kind, rows, onChange, withValues = true, disabled = false }: {
  kind: SecretKind;
  rows: SecretRow[];
  onChange: (rows: SecretRow[]) => void;
  withValues?: boolean;
  disabled?: boolean;
}) {
  const w = useWords();
  const id = useId();
  const problem = secretRowsError(rows, kind);
  const header = kind === "header";
  const update = (row: SecretRow, change: Partial<SecretRow>) => onChange(rows.map((item) => (item.id === row.id ? { ...item, ...change } : item)));
  const label = header ? w("Request headers", "请求头", "請求標頭") : w("Environment variables", "环境变量", "環境變數");
  return <Field group label={label}
    error={problem === "invalid"
      ? header ? w("Header names use letters, digits and hyphens.", "请求头名称只能包含字母、数字和连字符。", "請求標頭名稱只能包含字母、數字和連字號。") : w("Variable names use letters, digits and underscores and do not start with a digit.", "变量名只能包含字母、数字和下划线，且不能以数字开头。", "變數名稱只能包含字母、數字和底線，且不能以數字開頭。")
      : problem === "duplicate" ? w("Each name can appear only once.", "名称不能重复。", "名稱不能重複。") : undefined}
    hint={!withValues
      ? w("Only the names are set here; each person enters their own values in Settings → Connectors.", "这里只设置名称；每个人在“设置 → 连接器”中填写自己的值。", "這裡只設定名稱；每個人在「設定 → 連接器」中填寫自己的值。")
      : header
      ? w("For example Authorization with the value Bearer <token>. Values are stored on the platform and never shown again.", "例如 Authorization，值为 Bearer <token>。值保存在平台上，之后不会再显示。", "例如 Authorization，值為 Bearer <token>。值儲存在平台上，之後不會再顯示。")
      : w("Values are stored on the platform, passed to the program when it starts and never shown again.", "值保存在平台上，在程序启动时传给它，之后不会再显示。", "值儲存在平台上，在程式啟動時傳給它，之後不會再顯示。")}>
    {rows.length > 0 && <ul className="flex flex-col gap-2">
      {rows.map((row, index) => (
        <li key={row.id} className={withValues ? "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1.5 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto]" : "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2"}>
          {row.stored
            ? <span className="flex min-h-9 min-w-0 items-center gap-2 px-0.5 touch:min-h-11">
              <span className="min-w-0 truncate font-mono text-[12.5px] text-ink">{row.key}</span>{withValues && <SecretState set={row.set} />}
            </span>
            : <TextField aria-label={header ? w(`Header name ${index + 1}`, `请求头名称 ${index + 1}`, `請求標頭名稱 ${index + 1}`) : w(`Variable name ${index + 1}`, `变量名 ${index + 1}`, `變數名稱 ${index + 1}`)}
              id={`${id}-key-${row.id}`} autoComplete="off" spellCheck={false} disabled={disabled} value={row.key} inputClassName="font-mono"
              placeholder={header ? "Authorization" : "API_KEY"} onChange={(event) => update(row, { key: event.target.value })} />}
          {withValues && <TextField type="password" id={`${id}-value-${row.id}`} autoComplete="new-password" spellCheck={false} disabled={disabled} value={row.value} className="col-start-1 sm:col-start-auto"
            aria-label={w(`Value of ${row.key || `#${index + 1}`}`, `${row.key || `第 ${index + 1} 项`} 的值`, `${row.key || `第 ${index + 1} 項`} 的值`)}
            placeholder={row.set ? w("Leave empty to keep", "留空则保留", "留空則保留") : w("Value", "值", "值")}
            onChange={(event) => update(row, { value: event.target.value })} />}
          <button type="button" className={`${ICON_BUTTON} col-start-2 row-start-1 sm:col-start-auto sm:row-start-auto`} disabled={disabled}
            aria-label={w(`Remove ${row.key || `#${index + 1}`}`, `移除 ${row.key || `第 ${index + 1} 项`}`, `移除 ${row.key || `第 ${index + 1} 項`}`)}
            onClick={() => onChange(rows.filter((item) => item.id !== row.id))}>
            <Icon name="trash" size={15} />
          </button>
        </li>
      ))}
    </ul>}
    <Button type="button" size="sm" variant="secondary" className="self-start touch:h-11 touch:px-4" disabled={disabled} onClick={() => onChange([...rows, newSecretRow()])}>
      <Icon name="plus" size={14} />{header ? w("Add header", "添加请求头", "新增請求標頭") : w("Add variable", "添加变量", "新增變數")}
    </Button>
  </Field>;
}
