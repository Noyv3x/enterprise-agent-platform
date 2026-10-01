import { Children, isValidElement, memo, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import CodeBlock from "../../components/ui/beautiful/primitives/CodeBlock";
import { useWords } from "../../words";

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Puts StreamText's caret at the live edge: inside the last text-bearing element, not on a new line. */
function rehypeCaret() {
  return (tree: HastNode) => {
    let node = tree;
    for (;;) {
      const children = node.children ?? [];
      const last = [...children].reverse().find((child) => child.type === "element" || (child.type === "text" && child.value?.trim()));
      if (!last || last.type !== "element" || last.tagName === "pre" || (last.properties?.className as string[] | undefined)?.includes("katex")) break;
      node = last;
    }
    node.children = [...(node.children ?? []), { type: "element", tagName: "span", properties: { className: ["stream-caret", "is-streaming"], ariaHidden: "true" }, children: [] }];
  };
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? textOf(node.props.children) : "";
}

function Pre({ children }: ComponentPropsWithoutRef<"pre">) {
  const w = useWords();
  const first = Children.toArray(children)[0];
  const code = isValidElement<{ className?: string; children?: ReactNode }>(first) ? first : null;
  const language = /(?:^|\s)language-(\S+)/.exec(code?.props.className ?? "")?.[1];
  const value = textOf(code?.props.children ?? children).replace(/\n$/, "");
  return (
    <CodeBlock
      fill
      variant={language === "diff" || language === "patch" ? "Diff" : "Code"}
      code={value}
      filename={language ?? w("Code", "代码", "程式碼")}
      labels={{ copy: w("Copy", "复制", "複製"), copied: w("Copied", "已复制", "已複製"), copyCode: w("Copy code", "复制代码", "複製程式碼") }}
    />
  );
}

const components: Components = {
  a: ({ children, node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener">{children}</a>,
  pre: Pre,
  table: ({ children, node: _node, ...props }) => <div className="bui-table" tabIndex={0}><table {...props}>{children}</table></div>,
  // Remote images are never fetched from message text; files arrive as authorized attachments.
  img: ({ alt }) => <span>{alt}</span>,
};

const katexOptions = { output: "htmlAndMathml" as const, trust: false, maxExpand: 1000, maxSize: 20 };
const REMARK: Options["remarkPlugins"] = [remarkGfm, remarkMath, remarkBreaks];
const REHYPE: Options["rehypePlugins"] = [[rehypeKatex, katexOptions]];
const REHYPE_STREAMING: Options["rehypePlugins"] = [[rehypeKatex, katexOptions], rehypeCaret];

/** Agent Markdown (GFM, math, line breaks) with Beautiful UI code blocks; `streaming` adds the live caret. */
export const Markdown = memo(function Markdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return (
    <ReactMarkdown skipHtml components={components} remarkPlugins={REMARK} rehypePlugins={streaming ? REHYPE_STREAMING : REHYPE}>
      {content}
    </ReactMarkdown>
  );
});
