import { useId, useRef, useState, type ReactNode } from "react";
import { ApiError, request, type SkillView } from "../../api";
import { Button } from "../../components/ui/beautiful/atoms/Button";
import { SegmentedControl } from "../../components/ui/beautiful/atoms/SegmentedControl";
import { Dialog, Field, Icon, Notice, Select, TextField } from "../../components/ui/beautiful/controls";
import { cn } from "../../components/ui/beautiful/cn";
import { useWords } from "../../words";
import { formatBytes } from "../conversation/Attachments";

type Mode = "upload" | "link";
type Failure = { code: string; message: string; candidates: { name: string; subpath: string }[] };

const LINK = /^https?:\/\/\S+$/i;
const PACKAGE = /\.(zip|skill)$/i;

/** The typed parts of an install failure: `skill_exists`, or `skill_candidates` with the packages to choose from. */
function describeFailure(cause: unknown): Failure {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (!(cause instanceof ApiError)) return { code: "", message, candidates: [] };
  const list: unknown[] = Array.isArray(cause.details.candidates) ? cause.details.candidates : [];
  return {
    code: cause.code,
    message,
    candidates: list.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || !("subpath" in entry) || typeof entry.subpath !== "string") return [];
      const name = "name" in entry && typeof entry.name === "string" && entry.name ? entry.name : entry.subpath;
      return [{ name, subpath: entry.subpath }];
    }),
  };
}

/** Installs a skill package from an uploaded ZIP or .skill file, or from a link (POST `endpoint`, multipart `file`
 * or JSON `{url}`). A name that is already installed offers to replace it; an archive holding several skills asks
 * which one. `fields` (the administrator's group assignment) go with either body; `children` renders their controls. */
export function InstallDialog({ open, onClose, endpoint, onInstalled, note, fields = {}, ready = true, children }: {
  open: boolean;
  onClose: () => void;
  endpoint: string;
  onInstalled: (skill: SkillView) => void;
  /** a line under the description (for example, that the AI can install skills too) */
  note?: ReactNode;
  fields?: Record<string, unknown>;
  /** the extra fields are complete */
  ready?: boolean;
  children?: ReactNode;
}) {
  const w = useWords();
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [subpath, setSubpath] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const modes: Record<Mode, string> = { upload: w("Upload a file", "上传文件", "上傳檔案"), link: w("Paste a link", "粘贴链接", "貼上連結") };
  const link = url.trim();
  const linkInvalid = link !== "" && !LINK.test(link);
  const fileInvalid = file !== null && !PACKAGE.test(file.name);
  const choosing = failure?.code === "skill_candidates" && failure.candidates.length > 0;
  const sourceReady = mode === "upload" ? file !== null && !fileInvalid : link !== "" && !linkInvalid;
  const canInstall = sourceReady && ready && !busy && (!choosing || subpath !== "");

  const reset = () => { setSubpath(""); setFailure(null); };
  const finish = () => {
    setMode("upload"); setFile(null); setUrl(""); reset();
    onClose();
  };
  const choose = (files: FileList | File[] | null) => {
    const next = files?.[0];
    if (next) { setFile(next); reset(); }
  };

  async function install(replace = false) {
    if (!sourceReady || !ready || busy) return;
    setBusy(true);
    const options = { ...(subpath ? { subpath } : {}), ...(replace ? { replace: true } : {}), ...fields };
    let body: FormData | string;
    if (mode === "upload" && file) {
      body = new FormData();
      body.append("file", file);
      for (const [key, value] of Object.entries(options)) body.append(key, typeof value === "string" ? value : JSON.stringify(value));
    } else {
      body = JSON.stringify({ url: link, ...options });
    }
    try {
      const { skill } = await request<{ skill: SkillView }>(endpoint, { method: "POST", body });
      onInstalled(skill);
      setBusy(false);
      finish();
    } catch (cause) {
      setBusy(false);
      setFailure(describeFailure(cause));
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => { if (!busy) finish(); }}
      title={w("Install a skill", "安装技能", "安裝技能")}
      description={<>
        {w("A skill is a folder with a SKILL.md file, packed as a ZIP or .skill file or published at a link.", "技能是一个带 SKILL.md 的文件夹，可以打包成 ZIP 或 .skill 文件，也可以是一个链接。", "技能是一個帶 SKILL.md 的資料夾，可以打包成 ZIP 或 .skill 檔案，也可以是一個連結。")}
        {note && <span className="mt-1.5 block">{note}</span>}
      </>}
      footer={<>
        <Button type="button" size="sm" variant="secondary" className="touch:h-11 touch:px-4" disabled={busy} onClick={finish}>{w("Cancel", "取消", "取消")}</Button>
        <Button size="sm" variant="primary" type="submit" form={`${id}-form`} className="touch:h-11 touch:px-4" disabled={!canInstall} aria-busy={busy || undefined}>
          {busy ? w("Installing…", "正在安装…", "正在安裝…") : choosing ? w("Install selected skill", "安装所选技能", "安裝所選技能") : w("Install", "安装", "安裝")}
        </Button>
      </>}
    >
      <form id={`${id}-form`} noValidate className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void install(); }}>
        <SegmentedControl
          options={[modes.upload, modes.link]}
          value={modes[mode]}
          onChange={(label) => { setMode(label === modes.link ? "link" : "upload"); reset(); }}
          className="w-full touch:h-11"
        />
        {mode === "upload" ? (
          <Field group label={w("Package", "技能包", "技能包")}
            error={fileInvalid ? w("Choose a .zip or .skill file.", "请选择 .zip 或 .skill 文件。", "請選擇 .zip 或 .skill 檔案。") : undefined}
            hint={w("Up to 50 MB.", "最大 50 MB。", "最大 50 MB。")}>
            <div
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files); }}
              className={cn(
                "flex min-h-24 flex-col items-center justify-center gap-2 rounded-card border border-dashed px-4 py-4 text-center transition-colors duration-150",
                dragging ? "border-accent bg-accent-tint" : "border-line-strong bg-field",
              )}
            >
              {file ? (
                <span className="flex max-w-full items-center gap-2 text-[13px] text-ink">
                  <Icon name="folder" size={16} className="shrink-0 text-ink-2" />
                  <span className="min-w-0 truncate font-medium">{file.name}</span>
                  <span className="shrink-0 font-mono text-[12px] text-ink-2 tabular-nums">{formatBytes(file.size)}</span>
                </span>
              ) : (
                <span className="text-[12.5px] text-ink-2">{w("Drop a .zip or .skill file here", "把 .zip 或 .skill 文件拖到这里", "把 .zip 或 .skill 檔案拖到這裡")}</span>
              )}
              <Button type="button" size="sm" variant="secondary" className="touch:h-11 touch:px-4" disabled={busy} onClick={() => fileInput.current?.click()}>
                <Icon name="upload" size={14} />{file ? w("Choose another file", "重新选择", "重新選擇") : w("Choose file", "选择文件", "選擇檔案")}
              </Button>
              <input ref={fileInput} type="file" accept=".zip,.skill" className="sr-only" tabIndex={-1} aria-label={w("Skill package", "技能包", "技能包")}
                onChange={(event) => { choose(event.target.files); event.target.value = ""; }} />
            </div>
          </Field>
        ) : (
          <Field label={w("Link", "链接", "連結")} id={`${id}-url`}
            error={linkInvalid ? w("Enter a link that starts with https://", "请输入以 https:// 开头的链接", "請輸入以 https:// 開頭的連結") : undefined}
            hint={w("A GitHub repository or folder, a .zip, .tar.gz or .skill download, or a raw SKILL.md file.", "GitHub 仓库或目录、.zip / .tar.gz / .skill 下载链接，或 SKILL.md 原始文件链接。", "GitHub 儲存庫或目錄、.zip / .tar.gz / .skill 下載連結，或 SKILL.md 原始檔案連結。")}>
            <TextField type="url" inputMode="url" autoComplete="off" spellCheck={false} value={url} disabled={busy}
              placeholder="https://github.com/owner/repo/tree/main/skills/name"
              onChange={(event) => { setUrl(event.target.value); reset(); }} />
          </Field>
        )}
        {children}
        {choosing && (
          <Field label={w("Skill to install", "要安装的技能", "要安裝的技能")} id={`${id}-subpath`}
            hint={w("This package holds several skills; choose one.", "这个包里有多个技能，请选择一个。", "這個包裡有多個技能，請選擇一個。")}>
            <Select value={subpath || null} disabled={busy} placeholder={w("Choose a skill", "选择技能", "選擇技能")}
              options={failure.candidates.map((item) => ({ value: item.subpath, label: item.name, description: item.subpath }))}
              onChange={setSubpath} />
          </Field>
        )}
        {failure?.code === "skill_exists" ? (
          <Notice tone="warning" title={w("A skill with this name is already installed", "已经安装了同名技能", "已經安裝了同名技能")}
            action={<Button type="button" size="sm" className="touch:h-11" disabled={busy} onClick={() => void install(true)}>{w("Replace it", "替换", "取代")}</Button>}>
            {failure.message}
          </Notice>
        ) : failure && !choosing ? (
          <Notice tone="danger" title={w("The skill was not installed", "技能未安装", "技能未安裝")}>{failure.message}</Notice>
        ) : null}
      </form>
    </Dialog>
  );
}
