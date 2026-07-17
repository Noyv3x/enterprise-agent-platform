/* <Composer/> — the `<form class="composer">` host (legacy renderChat composer +
   submit + addDraftFiles, :664-743, 818-837). Owns the refs and per-scope draft
   plumbing; the textarea below it is never remounted.

   State ownership:
   - draft text + pending files live in the store keyed by draftKey (survive scope
     switches), read through controlled selectors;
   - the textarea ref, pending-caret ref, and isComposing ref are component refs;
   - useTypingNotifier owns the typing throttle; useAutoGrow resizes on the value;
   - useMention drives the @mention popover.

   Focus/scroll are owned by <ChatView> via tokens: onBumpFocus re-focuses the
   textarea, onBumpForceBottom snaps the list to the bottom. The send pipeline lives
   in data/chatActions.sendMessage; on failure we restore the draft + files and
   re-focus (legacy submit restore, :677-685). */

import { useCallback, useRef, type ChangeEvent } from "react";
import { useI18n } from "../../i18n";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES } from "../../lib/constants";
import { useAutoGrow } from "../../hooks/useAutoGrow";
import { useMention } from "../../hooks/useMention";
import { useToast } from "../../hooks/useToast";
import { useTypingNotifier } from "../../hooks/useTypingNotifier";
import { sendMessage } from "../../data/chatActions";
import { preserveFailedSend, restoreNextFailedSend } from "../../data/failedSendRecovery";
import { scopeTypeFor } from "../../store/selectors";
import { useDispatch, useStore, useStoreHandle } from "../../store/useStore";
import type { ChatMode } from "../../types";
import { ComposerField } from "./ComposerField";
import { ComposerFiles } from "./ComposerFiles";
import { FailedSendRecovery } from "./FailedSendRecovery";
import { ComposerHint } from "./ComposerHint";
import type { ComposerTextareaProps } from "./ComposerTextarea";

const EMPTY_FILES: File[] = [];

export function Composer({
  mode,
  scopeId,
  draftKey,
  disabled,
  placeholder,
  focusToken,
  onBumpFocus,
  onBumpForceBottom,
}: {
  mode: ChatMode;
  scopeId: string;
  draftKey: string;
  disabled: boolean;
  placeholder: string;
  focusToken: number;
  onBumpFocus: () => void;
  onBumpForceBottom: () => void;
}) {
  const store = useStoreHandle();
  const dispatch = useDispatch();
  const toast = useToast();
  const { t } = useI18n();

  const draft = useStore((state) => state.drafts[draftKey] || "");
  const rawFiles = useStore((state) => state.draftFiles[draftKey]);
  const selectedFiles = rawFiles ?? EMPTY_FILES;
  const failedSends = useStore((state) => state.failedSends[draftKey] || []);
  const mentionTargets = useStore((state) => state.mentionTargets);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const isComposingRef = useRef(false);

  const notify = useTypingNotifier(mode, scopeId);
  useAutoGrow(textareaRef, draft);

  const menuId = `mention-menu-${scopeTypeFor(mode)}-${scopeId}`;

  const setDraft = useCallback(
    (value: string) => dispatch({ type: "SET_DRAFT", payload: { key: draftKey, value } }),
    [dispatch, draftKey],
  );
  const setPendingCaret = useCallback((position: number) => {
    pendingCaretRef.current = position;
  }, []);

  const mention = useMention({
    textareaRef,
    mode,
    menuId,
    mentionTargets,
    isComposingRef,
    setDraft,
    setPendingCaret,
    notify,
  });

  /* legacy addDraftFiles (:818-837): reject >50MB (toast), append + cap at 10
     (toast on overflow), then re-focus the composer. */
  const addDraftFiles = useCallback(
    (incoming: File[]) => {
      const current = store.getState().draftFiles[draftKey] || EMPTY_FILES;
      const accepted: File[] = [];
      for (const file of incoming) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          toast(t("chat.attach.tooLarge", { name: file.name || t("chat.attachment"), limit: "50 MB" }), {
            title: t("chat.attach.tooLargeTitle"),
          });
          continue;
        }
        accepted.push(file);
      }
      if (!accepted.length) return;
      const next = [...current, ...accepted].slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
      if (current.length + accepted.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        toast(t("chat.attach.tooMany", { count: MAX_ATTACHMENTS_PER_MESSAGE }), {
          title: t("chat.attach.tooManyTitle"),
        });
      }
      dispatch({ type: "SET_DRAFT_FILES", payload: { key: draftKey, files: next } });
      onBumpFocus();
    },
    [store, dispatch, draftKey, toast, t, onBumpFocus],
  );

  const removeFile = useCallback(
    (index: number) => {
      const next = [...(store.getState().draftFiles[draftKey] || EMPTY_FILES)];
      next.splice(index, 1);
      if (next.length) dispatch({ type: "SET_DRAFT_FILES", payload: { key: draftKey, files: next } });
      else dispatch({ type: "REMOVE_DRAFT_FILES", payload: { key: draftKey } });
      onBumpFocus();
    },
    [store, dispatch, draftKey, onBumpFocus],
  );

  const onFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const incoming = Array.from(event.target.files || []);
      event.target.value = ""; // reset so the same file can be re-picked
      if (!incoming.length) return;
      addDraftFiles(incoming);
    },
    [addDraftFiles],
  );

  const submit = useCallback(async () => {
    if (isComposingRef.current) return; // never submit mid-IME
    const content = (store.getState().drafts[draftKey] || textareaRef.current?.value || "").trim();
    const files = store.getState().draftFiles[draftKey] || EMPTY_FILES;
    if ((!content && !files.length) || disabled) return;
    // Clear, focus + snap to bottom, and tell the server we stopped typing. These
    // sync dispatches batch with the optimistic insert inside sendMessage.
    setDraft("");
    dispatch({ type: "REMOVE_DRAFT_FILES", payload: { key: draftKey } });
    // If an earlier failed payload is waiting, promote it intact after the
    // current draft has been captured. The user can keep sending in FIFO order
    // without merging unrelated files into one message.
    restoreNextFailedSend(store, draftKey);
    onBumpFocus();
    onBumpForceBottom();
    notify(false);
    const sent = await sendMessage(store, mode, scopeId, content, files);
    if (sent === false) {
      preserveFailedSend(store, draftKey, content, files);
      onBumpFocus();
    }
  }, [disabled, draftKey, mode, scopeId, store, dispatch, setDraft, notify, toast, t, onBumpFocus, onBumpForceBottom]);

  const textareaProps: ComposerTextareaProps = {
    textareaRef,
    pendingCaretRef,
    isComposingRef,
    value: draft,
    disabled,
    placeholder,
    mode,
    menuId,
    focusToken,
    mention,
    onDraftChange: setDraft,
    onSubmit: submit,
    onAddFiles: addDraftFiles,
    notify,
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="composer__wrap">
        {failedSends.length ? (
          <FailedSendRecovery
            sends={failedSends}
            blocked={!!draft || !!selectedFiles.length}
            onRestore={() => {
              restoreNextFailedSend(store, draftKey);
              onBumpFocus();
            }}
          />
        ) : null}
        <ComposerField
          disabled={disabled}
          fileInputRef={fileInputRef}
          onFileChange={onFileChange}
          textarea={textareaProps}
        />
        {selectedFiles.length ? <ComposerFiles files={selectedFiles} onRemove={removeFile} /> : null}
        <ComposerHint />
      </div>
    </form>
  );
}
