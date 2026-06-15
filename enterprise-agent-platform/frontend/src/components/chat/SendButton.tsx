/* <SendButton/> — the composer submit button (legacy composer send button, :731).
   type="submit" so it triggers the enclosing <form>'s onSubmit. */

import { Icon } from "../common/Icon";

export function SendButton({ disabled }: { disabled: boolean }) {
  return (
    <button
      className="btn btn--primary composer__send"
      type="submit"
      title="发送 (Enter)"
      aria-label="发送"
      disabled={disabled}
    >
      <Icon name="send" size={18} />
    </button>
  );
}
