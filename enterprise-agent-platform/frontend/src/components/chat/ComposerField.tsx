/* <ComposerField/> — the `.composer__field` row (focus-within ring) holding the
   hidden file input + attach button, the controlled textarea, the in-field mention
   popover, and the send button (legacy composer__field, :719-734). Layout only;
   all behavior is threaded down from <Composer>. */

import { type ChangeEvent, type RefObject } from "react";
import { AttachButton } from "./AttachButton";
import { ComposerTextarea, type ComposerTextareaProps } from "./ComposerTextarea";
import { MentionMenu } from "./MentionMenu";
import { SendButton } from "./SendButton";

export function ComposerField({
  disabled,
  fileInputRef,
  onFileChange,
  textarea,
}: {
  disabled: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  textarea: ComposerTextareaProps;
}) {
  return (
    <div className="composer__field">
      <input
        ref={fileInputRef}
        className="composer__file-input"
        type="file"
        multiple
        tabIndex={-1}
        onChange={onFileChange}
      />
      <AttachButton disabled={disabled} onClick={() => fileInputRef.current?.click()} />
      <ComposerTextarea {...textarea} />
      <MentionMenu mention={textarea.mention} />
      <SendButton disabled={disabled} />
    </div>
  );
}
