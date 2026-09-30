import { Children, isValidElement, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { Button, highlight } from "../../components/ui/beautiful";
import { useWords } from "../../words";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? textOf(node.props.children) : "";
}

function CodeBlock({ children }: ComponentPropsWithoutRef<"pre">) {
  const w = useWords();
  const [copied, setCopied] = useState(false);
  const first = Children.toArray(children)[0];
  const code = isValidElement<{ className?: string; children?: ReactNode }>(first) ? first : null;
  const language = /(?:^|\s)language-(\S+)/.exec(code?.props.className ?? "")?.[1];
  const value = textOf(code?.props.children ?? children).replace(/\n$/, "");
  return (
    <figure className="cv-code">
      <figcaption>
        <span className="wf-mono">{language ?? w("Code", "代码", "程式碼")}</span>
        <Button
          type="button"
          variant="quiet"
          size="xs"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? w("Copied", "已复制", "已複製") : w("Copy", "复制", "複製")}
        </Button>
      </figcaption>
      <pre tabIndex={0}>
        <code>{value.split("\n").map((line, index) => <span key={index} className="cv-code-line">{line ? highlight(line) : "\u200b"}</span>)}</code>
      </pre>
    </figure>
  );
}

const components: Components = {
  a: ({ children, node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener">{children}</a>,
  pre: CodeBlock,
  table: ({ children, node: _node, ...props }) => <div className="cv-table" tabIndex={0}><table {...props}>{children}</table></div>,
  // Remote images are never fetched from message text; files arrive as authorized attachments.
  img: ({ alt }) => <span>{alt}</span>,
};

const katexOptions = { output: "htmlAndMathml" as const, trust: false, maxExpand: 1000, maxSize: 20 };

export function Markdown({ content }: { content: string }) {
  return (
    <div className="cv-prose">
      <ReactMarkdown skipHtml components={components} remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]} rehypePlugins={[[rehypeKatex, katexOptions]]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
