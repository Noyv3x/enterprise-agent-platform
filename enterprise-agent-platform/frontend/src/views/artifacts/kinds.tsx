import type { ReactNode } from "react";
import type { ArtifactKind } from "./types";
import type { Words } from "../conversation/work";

/** The kind as people read it on cards and in the panel: "v3 · 网页". */
export function kindLabel(kind: ArtifactKind, w: Words): string {
  switch (kind) {
    case "web":
      return w("Web page", "网页", "網頁");
    case "site":
      return w("Website", "网站", "網站");
    case "markdown":
      return w("Document", "文档", "文件");
    case "mermaid":
      return w("Diagram", "示意图", "示意圖");
    case "svg":
      return w("Vector image", "矢量图", "向量圖");
    case "table":
      return w("Table", "表格", "表格");
    case "code":
      return w("Code", "代码", "程式碼");
    case "image":
      return w("Image", "图片", "圖片");
    case "pdf":
      return "PDF";
  }
}

/* 24px line glyphs in the style of the controls' Icon set, one per kind. */
const GLYPHS: Record<ArtifactKind, ReactNode> = {
  web: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M3.5 9h17M7 6.75h.01M9.5 6.75h.01" /></>,
  site: <><rect x="6.5" y="3.5" width="14" height="12" rx="2.5" /><path d="M6.5 7.5h14M17.5 15.5v2a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1" /></>,
  markdown: <><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" /><path d="M14 3.5v5h5M8.5 13h7M8.5 16.5h5" /></>,
  mermaid: <><rect x="3.5" y="4" width="6.5" height="5" rx="1.5" /><rect x="14" y="15" width="6.5" height="5" rx="1.5" /><path d="M6.75 9v4.5a2 2 0 0 0 2 2H14" /></>,
  svg: <><path d="M4.5 19.5 9 8l4 7 2.5-4 4 8.5z" /><circle cx="16.5" cy="6.5" r="2" /></>,
  table: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10" /></>,
  code: <path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13" />,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.75" /><path d="m20.5 16-4.5-4.5-8 8" /></>,
  pdf: <><path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" /><path d="M14 3.5v5h5" /><path d="M8.5 16.5v-4h1.25a1.25 1.25 0 0 1 0 2.5H8.5" /></>,
};

export function KindIcon({ kind, size = 15 }: { kind: ArtifactKind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      {GLYPHS[kind] ?? GLYPHS.code}
    </svg>
  );
}
