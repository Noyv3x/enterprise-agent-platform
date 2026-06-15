/* <MessageBody/> — the message text (legacy renderMessage body, :890). Rendered
   only when content is truthy (the caller guards) so the streaming caret pseudo-
   element never attaches to an empty node. white-space:pre-wrap lives in CSS. */

export function MessageBody({ content }: { content: string }) {
  return <div className="msg__body">{content}</div>;
}
