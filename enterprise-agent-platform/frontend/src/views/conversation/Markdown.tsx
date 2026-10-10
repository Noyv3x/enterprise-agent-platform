import { Children, isValidElement, memo, useMemo, useRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
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

/** Parses block structure only (inline breaks do not move block boundaries). */
const blockParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
/** Link reference and footnote definitions resolve across blocks, so such content renders as one block. */
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m;

/** `content` as top-level Markdown blocks: `settled` sources, which later text can no longer change, then the tail
 * from `offset`. */
interface Blocks {
  content: string;
  settled: string[];
  offset: number;
}

/** Extends `previous` when `content` only appended to its settled part, so only the tail is parsed again. A block is
 * settled once a later block began, except a list right before the last block: that block may still become one of
 * its items. */
function splitBlocks(previous: Blocks | null, content: string): Blocks {
  if (DEFINITION.test(content)) return { content, settled: [], offset: 0 };
  const reuse = previous !== null && content.startsWith(previous.content.slice(0, previous.offset));
  const settled = reuse ? [...previous.settled] : [];
  let offset = reuse ? previous.offset : 0;
  const tail = content.slice(offset);
  const nodes = blockParser.parse(tail).children;
  // Each block starts at the beginning of its first line.
  const starts = nodes.map(({ position }) => (position ? position.start.offset! - (position.start.column - 1) : 0));
  let keep = nodes.length - 1;
  if (keep > 0 && nodes[keep - 1].type === "list") keep -= 1;
  if (keep <= 0) return { content, settled, offset };
  for (let index = 0; index < keep; index++) settled.push(tail.slice(starts[index], starts[index + 1]));
  offset += starts[keep];
  return { content, settled, offset };
}

const Block = memo(function Block({ source, streaming }: { source: string; streaming: boolean }) {
  return (
    <ReactMarkdown skipHtml components={components} remarkPlugins={REMARK} rehypePlugins={streaming ? REHYPE_STREAMING : REHYPE}>
      {source}
    </ReactMarkdown>
  );
});

/** Agent Markdown (GFM, math, line breaks) with Beautiful UI code blocks; `streaming` adds the live caret.
 * Rendered per top-level block: while text streams in, settled blocks keep their elements and only the tail is
 * parsed and rendered again. */
export const Markdown = memo(function Markdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const previous = useRef<Blocks | null>(null);
  const blocks = useMemo(() => (previous.current = splitBlocks(previous.current, content)), [content]);
  return (
    <>
      {blocks.settled.map((source, index) => <Block key={index} source={source} streaming={false} />)}
      <Block key={blocks.settled.length} source={content.slice(blocks.offset)} streaming={streaming} />
    </>
  );
});
