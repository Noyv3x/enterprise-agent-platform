/* <AttachButton/> — the composer paperclip that opens the hidden file input
   (legacy composer attach button, :721-728). */

import { Icon } from "../common/Icon";

export function AttachButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button
      className="icon-btn composer__attach"
      type="button"
      title="添加文件"
      aria-label="添加文件"
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name="paperclip" size={18} />
    </button>
  );
}
