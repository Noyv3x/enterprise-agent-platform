/* Safe Markdown/GFM rendering. Raw HTML is skipped, unsafe URL protocols use
 * react-markdown's default filter, and remote images never reach the browser. */

import { Children, isValidElement, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useI18n } from "../../i18n";
import { CopyButton } from "./CopyButton";

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function MarkdownCodeBlock({ children }: ComponentPropsWithoutRef<"pre">) {
  const { t } = useI18n();
  const child = Children.toArray(children)[0];
  const code = isValidElement<{ className?: string; children?: ReactNode }>(child) ? child : null;
  const className = code?.props.className || "";
  const language = /(?:^|\s)language-([^\s]+)/.exec(className)?.[1] || "";
  const value = nodeText(code?.props.children ?? children).replace(/\n$/, "");

  return (
    <div className="md-code">
      <div className="md-code__head">
        <span>{language || t("chat.markdown.codeLabel")}</span>
        <CopyButton value={value} kind="code" />
      </div>
      <pre><code className={className || undefined}>{value}</code></pre>
    </div>
  );
}

function MarkdownTable({
  children,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<"table"> & { node?: unknown }) {
  const { t } = useI18n();
  return (
    <div className="md-table-wrap" role="region" aria-label={t("chat.markdown.tableLabel")} tabIndex={0}>
      <table {...props}>{children}</table>
    </div>
  );
}

function BlockedMarkdownImage({ alt }: { alt?: string }) {
  const { t } = useI18n();
  return (
    <span className="md-image-blocked" role="note">
      {t("chat.markdown.imageBlocked", { alt: alt || t("chat.markdown.imageFallback") })}
    </span>
  );
}

const markdownComponents: Components = {
  a: ({ children, node: _node, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer noopener">{children}</a>
  ),
  pre: MarkdownCodeBlock,
  table: MarkdownTable,
  img: ({ alt }) => <BlockedMarkdownImage alt={alt || undefined} />,
};

export function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={markdownComponents}>
      {content}
    </ReactMarkdown>
  );
}
