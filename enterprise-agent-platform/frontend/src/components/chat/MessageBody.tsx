import { lazy, Suspense } from "react";

const MarkdownContent = lazy(() =>
  import("./MarkdownContent").then((module) => ({ default: module.MarkdownContent })),
);

/** Lazy-load the Markdown parser only when chat content is actually rendered. */
export function MessageBody({ content }: { content: string }) {
  return (
    <div className="msg__body">
      <Suspense fallback={<span className="md-plaintext">{content}</span>}>
        <MarkdownContent content={content} />
      </Suspense>
    </div>
  );
}
