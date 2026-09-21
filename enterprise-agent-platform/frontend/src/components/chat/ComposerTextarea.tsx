import { useLayoutEffect, type RefObject } from "react";
import { useI18n } from "../../i18n";
import { clipboardImageFiles } from "../../utils/composerFiles";
import type { ChatMode } from "../../types";
import type { MentionApi } from "../../hooks/useMention";

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
  slashCommand?: { active: boolean; choose: () => void; dismiss: () => void; menuId: string; optionId: string };
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onAddFiles: (files: File[]) => void;
  onCompositionChange?: (isComposing: boolean) => void;
  notify: (isTyping: boolean) => void;
}

export function ComposerTextarea({ textareaRef, pendingCaretRef, isComposingRef, value, disabled, placeholder, mode, menuId, focusToken, mention, slashCommand, onDraftChange, onSubmit, onAddFiles, onCompositionChange, notify }: ComposerTextareaProps) {
  const { t } = useI18n();
  const channel = mode === "channel";
  const hasPopup = channel || slashCommand?.active;
  useLayoutEffect(() => {
    const input = textareaRef.current;
    const caret = pendingCaretRef.current;
    if (input && caret != null) {
      pendingCaretRef.current = null;
      input.setSelectionRange(caret, caret);
    }
  }, [value, textareaRef, pendingCaretRef]);
  useLayoutEffect(() => {
    if (focusToken > 0) textareaRef.current?.focus();
  }, [focusToken, textareaRef]);

  return <textarea className="bui-composer-input" data-composer-input
    ref={textareaRef} value={value} disabled={disabled} placeholder={placeholder} rows={1}
    aria-label={t("chat.composer.inputLabel")}
    role={hasPopup ? "combobox" : undefined}
    aria-haspopup={hasPopup ? "listbox" : undefined}
    aria-autocomplete={hasPopup ? "list" : undefined}
    aria-controls={slashCommand?.active ? slashCommand.menuId : channel ? menuId : undefined}
    aria-expanded={hasPopup ? Boolean(slashCommand?.active || mention.active) : undefined}
    aria-activedescendant={slashCommand?.active ? slashCommand.optionId : channel && mention.activeDescendant ? mention.activeDescendant : undefined}
    onChange={(event) => {
      const next = event.target.value;
      onDraftChange(next);
      mention.update();
      const nativeComposing = "isComposing" in event.nativeEvent && event.nativeEvent.isComposing === true;
      if (!isComposingRef.current && !nativeComposing) notify(next.trim().length > 0);
    }}
    onFocus={mention.update} onClick={mention.update} onBlur={mention.scheduleHide}
    onPaste={(event) => {
      const images = clipboardImageFiles(event.clipboardData);
      if (images.length) { event.preventDefault(); onAddFiles(images); }
    }}
    onKeyUp={(event) => { if (!MENU_NAV_KEYS.includes(event.key)) mention.update(); }}
    onCompositionStart={() => {
      isComposingRef.current = true;
      onCompositionChange?.(true);
      mention.hide();
    }}
    onCompositionEnd={(event) => {
      isComposingRef.current = false;
      onCompositionChange?.(false);
      const next = event.currentTarget.value;
      onDraftChange(next);
      notify(next.trim().length > 0);
      mention.update();
    }}
    onKeyDown={(event) => {
      if (isComposingRef.current || event.nativeEvent.isComposing) return;
      if (mention.handleKey(event)) return;
      if (slashCommand?.active && event.key === "Escape") {
        event.preventDefault(); slashCommand.dismiss(); return;
      }
      if (slashCommand?.active && value.trimStart().toLocaleLowerCase() !== "/compact" && (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
        event.preventDefault(); slashCommand.choose(); return;
      }
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSubmit(); }
    }}
  />;
}
