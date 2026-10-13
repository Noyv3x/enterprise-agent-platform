/** Loading, failure and code-label pieces the artifact renderers share. */
import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/beautiful/atoms/Button";
import { Notice } from "../../../components/ui/beautiful/controls";
import type { CodeBlockLabels } from "../../../components/ui/beautiful/primitives/CodeBlock";
import LoadingState from "../../../components/ui/beautiful/primitives/LoadingState";
import { useWords } from "../../../words";

/** CodeBlock's copy labels in the reader's language. */
export function useCodeLabels(): CodeBlockLabels {
  const w = useWords();
  return { copy: w("Copy", "复制", "複製"), copied: w("Copied", "已复制", "已複製"), copyCode: w("Copy code", "复制代码", "複製程式碼") };
}

export type Loaded<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "failed"; error: Error; retry: () => void };

/** Runs `load` on mount and whenever `key` changes; a superseded result is dropped. */
export function useLoaded<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; loaded: Loaded<T> }>({ key, loaded: { status: "loading" } });
  useEffect(() => {
    let live = true;
    setState({ key, loaded: { status: "loading" } });
    load().then(
      (value) => live && setState({ key, loaded: { status: "ready", value } }),
      (error: unknown) => live && setState({
        key,
        loaded: { status: "failed", error: error instanceof Error ? error : new Error(String(error)), retry: () => setAttempt((n) => n + 1) },
      }),
    );
    return () => { live = false; };
    // `load` is a fresh closure each render; `key` names what it loads.
  }, [key, attempt]);
  return state.key === key ? state.loaded : { status: "loading" };
}

/** Centered loading status for a renderer that fills its parent. */
export function RendererLoading() {
  const w = useWords();
  return (
    <div className="flex h-full min-h-40 items-center justify-center p-6">
      <LoadingState label={w("Loading…", "正在载入…", "正在載入…")} />
    </div>
  );
}

/** A failed load with the server's reason and a retry; `title` names what failed (default: the artifact). */
export function RendererFailed({ error, retry, title }: { error: Error; retry: () => void; title?: string }) {
  const w = useWords();
  return (
    <div className="p-4">
      <Notice
        tone="danger"
        title={title ?? w("Couldn't load this artifact", "无法载入作品内容", "無法載入作品內容")}
        action={<Button size="xs" onClick={retry}>{w("Retry", "重试", "重試")}</Button>}
      >
        {error.message}
      </Notice>
    </div>
  );
}

/** The source endpoint stops at 2 MB; says that only the beginning is shown. */
export function TruncatedNote({ className }: { className?: string }) {
  const w = useWords();
  return (
    <Notice className={className} title={w("Showing the first 2 MB", "只显示开头 2 MB", "只顯示開頭 2 MB")}>
      {w("The file is larger; download it for the whole content.", "文件更大，下载可查看完整内容。", "檔案更大，下載可查看完整內容。")}
    </Notice>
  );
}
