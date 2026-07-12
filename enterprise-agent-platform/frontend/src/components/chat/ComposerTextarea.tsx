/* <ComposerTextarea/> — the controlled, IME-aware composer textarea (legacy
   renderChat textarea, :610-662). This is the #1 reconciliation hazard: it must
   NEVER remount (stable identity + a fixed position in the tree), and its value is
   controlled from the per-scope store draft. Because it is never torn down, Chinese
   IME composition is no longer interrupted; we still track isComposing
   (onCompositionStart/End + native event.isComposing) so we never submit or send a
   typing ping mid-composition.

   Two post-commit layout effects (run before paint, child-before-parent):
   - caret restore: after a mention-insert / programmatic value change, apply the
     pending caret (else the caret jumps to the end);
   - focus: re-focus on focusToken bumps (send / nav / attach / send-failure).
   autoGrow is owned by the parent <Composer> (useAutoGrow on the same ref). */

import { useLayoutEffect, type RefObject } from "react";
import { useI18n } from "../../i18n";
import { clipboardImageFiles } from "../../utils/composerFiles";
import type { ChatMode } from "../../types";
import type { MentionApi } from "../../hooks/useMention";

/** Keys that drive mention nav themselves — they must NOT also trigger a generic
 *  menu recompute on keyup (legacy onkeyup guard, :638-640). */
const MENU_NAV_KEYS = ["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Tab", "Escape"];

export interface ComposerTextareaProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  pendingCaretRef: RefObject<number | null>;
  isComposingRef: RefObject<boolean>;
  value: string;
  disabled: boolean;
  placeholder: string;
  mode: ChatMode;
  menuId: string;
  focusToken: number;
  mention: MentionApi;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onAddFiles: (files: File[]) => void;
  notify: (isTyping: boolean) => void;
}

export function ComposerTextarea({
  textareaRef,
  pendingCaretRef,
  isComposingRef,
  value,
  disabled,
  placeholder,
  mode,
  menuId,
  focusToken,
  mention,
  onDraftChange,
  onSubmit,
  onAddFiles,
  notify,
}: ComposerTextareaProps) {
  const { t } = useI18n();
  const channel = mode === "channel";

  // Apply a pending caret (set by mention insert) after the controlled value commits.
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    const pending = pendingCaretRef.current;
    if (pending != null) {
      pendingCaretRef.current = null;
      element.setSelectionRange(pending, pending);
    }
  }, [value, textareaRef, pendingCaretRef]);

  // Focus after send / nav / attach (focusToken bump). Disabled textarea = no-op.
  useLayoutEffect(() => {
    textareaRef.current?.focus();
  }, [focusToken, textareaRef]);

  return (
    <textarea
      ref={textareaRef}
      rows={1}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={t("chat.composer.inputLabel")}
      role={channel ? "combobox" : undefined}
      aria-haspopup={channel ? "listbox" : undefined}
      aria-autocomplete={channel ? "list" : undefined}
      aria-controls={channel ? menuId : undefined}
      aria-expanded={channel ? mention.active : undefined}
      aria-activedescendant={channel && mention.activeDescendant ? mention.activeDescendant : undefined}
      onChange={(event) => {
        const next = event.target.value;
        onDraftChange(next);
        mention.update();
        const composing =
          isComposingRef.current || (event.nativeEvent as { isComposing?: boolean }).isComposing === true;
        if (!composing) notify(next.trim().length > 0);
      }}
      onFocus={() => mention.update()}
      onClick={() => mention.update()}
      onPaste={(event) => {
        const images = clipboardImageFiles(event.clipboardData);
        if (!images.length) return;
        event.preventDefault();
        onAddFiles(images);
      }}
      onKeyUp={(event) => {
        if (!MENU_NAV_KEYS.includes(event.key)) mention.update();
      }}
      onBlur={() => mention.scheduleHide()}
      onCompositionStart={() => {
        isComposingRef.current = true;
        mention.hide();
      }}
      onCompositionEnd={(event) => {
        isComposingRef.current = false;
        const next = event.currentTarget.value;
        onDraftChange(next);
        notify(next.trim().length > 0);
        mention.update();
      }}
      onKeyDown={(event) => {
        if (!event.nativeEvent.isComposing && mention.handleKey(event)) return;
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onSubmit();
        }
      }}
    />
  );
}
