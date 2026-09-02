/* <Composer/> — the `<form class="composer">` host. Owns refs and per-scope draft
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
   re-focus. */

import { useCallback, useLayoutEffect, useRef, useState, type ChangeEvent } from "react";
import { useI18n } from "../../i18n";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES } from "../../lib/constants";
import { relinquishBrowserControlFor } from "../../lib/browserControl";
import { useAutoGrow } from "../../hooks/useAutoGrow";
import { useMention } from "../../hooks/useMention";
import { useToast } from "../../hooks/useToast";
import { useTypingNotifier } from "../../hooks/useTypingNotifier";
import { compactAgentSession, sendMessage } from "../../data/chatActions";
import { getApiSessionGeneration, isApiError } from "../../lib/api";
import { preserveFailedSend, restoreNextFailedSend } from "../../data/failedSendRecovery";
import { scopeTypeFor } from "../../store/selectors";
import { useDispatch, useStore, useStoreHandle } from "../../store/useStore";
import type { ChatMode, FailedSend } from "../../types";
import { ComposerField } from "./ComposerField";
import { ComposerFiles } from "./ComposerFiles";
import { FailedSendRecovery } from "./FailedSendRecovery";
import { ComposerHint } from "./ComposerHint";
import type { ComposerTextareaProps } from "./ComposerTextarea";

const EMPTY_FILES: File[] = [];
const EMPTY_FAILED_SENDS: FailedSend[] = [];

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
  const rawFailedSends = useStore((state) => state.failedSends[draftKey]);
  const failedSends = rawFailedSends ?? EMPTY_FAILED_SENDS;
  const mentionTargets = useStore((state) => state.mentionTargets);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const isComposingRef = useRef(false);
  const activeDraftKeyRef = useRef(draftKey);
  const activeScopeRef = useRef({ mode, scopeId });
  const mountedRef = useRef(false);
  const commandRequestsRef = useRef(new Map<string, symbol>());
  const [commandScopesInFlight, setCommandScopesInFlight] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [dismissedSlashCommand, setDismissedSlashCommand] = useState<{
    draftKey: string;
    query: string;
  } | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const commandInFlight = commandScopesInFlight.has(draftKey);

  useLayoutEffect(() => {
    activeDraftKeyRef.current = draftKey;
    activeScopeRef.current = { mode, scopeId };
  }, [draftKey, mode, scopeId]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const notify = useTypingNotifier(mode, scopeId);
  useAutoGrow(textareaRef, draft);

  const menuId = `mention-menu-${scopeTypeFor(mode)}-${scopeId}`;
  const slashMenuId = `slash-menu-${scopeTypeFor(mode)}-${scopeId}`;
  const slashOptionId = `${slashMenuId}-compact`;

  const setDraft = useCallback(
    (value: string) => dispatch({ type: "SET_DRAFT", payload: { key: draftKey, value } }),
    [dispatch, draftKey],
  );
  const updateDraft = useCallback((value: string) => {
    setDismissedSlashCommand(null);
    setDraft(value);
  }, [setDraft]);
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

  /* Reject files over 50 MB, cap the queue at 10 and re-focus the composer. */
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
    if (commandRequestsRef.current.has(draftKey)) return;
    const content = (store.getState().drafts[draftKey] || textareaRef.current?.value || "").trim();
    const files = store.getState().draftFiles[draftKey] || EMPTY_FILES;
    if ((!content && !files.length) || disabled) return;
    const compactInvocation = /^\/compact(?:\s|$)/iu.test(content);
    if (compactInvocation) {
      if (content.toLocaleLowerCase() !== "/compact") {
        toast(t("chat.commands.compactNoArguments"), {
          type: "error",
          title: t("chat.commands.compactFailedTitle"),
        });
        return;
      }
      if (files.length) {
        toast(t("chat.commands.compactNoAttachments"), {
          type: "error",
          title: t("chat.commands.compactFailedTitle"),
        });
        return;
      }
      const requestToken = Symbol(draftKey);
      commandRequestsRef.current.set(draftKey, requestToken);
      setCommandScopesInFlight((current) => {
        const next = new Set(current);
        next.add(draftKey);
        return next;
      });
      try {
        const result = await compactAgentSession(mode, scopeId);
        const currentDraft = store.getState().drafts[draftKey] || "";
        if (currentDraft.trim().toLocaleLowerCase() === "/compact") {
          setDraft("");
          notify(false);
        }
        if (activeDraftKeyRef.current === draftKey) {
          if (result.compacted) {
            toast(
              t("chat.commands.compactDone", {
                omitted: result.omitted_messages,
                retained: result.retained_messages,
              }),
              { type: "ok", title: t("chat.commands.compactDoneTitle") },
            );
          } else {
            toast(t("chat.commands.compactNoop"), {
              type: "ok",
              title: t("chat.commands.compactNoopTitle"),
            });
          }
        }
      } catch (error) {
        if (activeDraftKeyRef.current === draftKey) {
          toast(
            isApiError(error, 409)
              ? t("chat.commands.compactBusy")
              : t("chat.commands.compactFailed"),
            { type: "error", title: t("chat.commands.compactFailedTitle") },
          );
        }
      } finally {
        if (commandRequestsRef.current.get(draftKey) === requestToken) {
          commandRequestsRef.current.delete(draftKey);
          setCommandScopesInFlight((current) => {
            if (!current.has(draftKey)) return current;
            const next = new Set(current);
            next.delete(draftKey);
            return next;
          });
          if (activeDraftKeyRef.current === draftKey) onBumpFocus();
        }
      }
      return;
    }
    const accountGeneration = getApiSessionGeneration();
    const submittingUserId = store.getState().user?.id ?? null;
    const submittingScope = activeScopeRef.current;
    const browserHandoff = relinquishBrowserControlFor({ scope_type: mode, scope_id: scopeId });
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
    await browserHandoff;
    const latestState = store.getState();
    const accountChanged = (
      getApiSessionGeneration() !== accountGeneration
      || (latestState.user?.id ?? null) !== submittingUserId
    );
    if (accountChanged) return;
    if (!mountedRef.current || activeScopeRef.current !== submittingScope) {
      preserveFailedSend(store, draftKey, content, files);
      return;
    }
    const sent = await sendMessage(store, mode, scopeId, content, files);
    if (sent === false) {
      preserveFailedSend(store, draftKey, content, files);
      onBumpFocus();
    }
  }, [disabled, draftKey, mode, scopeId, store, dispatch, setDraft, notify, toast, t, onBumpFocus, onBumpForceBottom]);

  const slashQuery = draft.trimStart();
  const slashCommandEligible = Boolean(
    slashQuery
    && !slashQuery.includes("\n")
    && "/compact".startsWith(slashQuery.toLocaleLowerCase()),
  );
  const slashCommandVisible = Boolean(
    slashCommandEligible
    && !commandInFlight
    && !isComposing
    && !(
      dismissedSlashCommand?.draftKey === draftKey
      && dismissedSlashCommand.query === slashQuery
    ),
  );
  const chooseSlashCommand = useCallback(() => {
    setDismissedSlashCommand(null);
    setDraft("/compact");
    setPendingCaret("/compact".length);
    onBumpFocus();
  }, [onBumpFocus, setDraft, setPendingCaret]);
  const dismissSlashCommand = useCallback(() => {
    setDismissedSlashCommand({ draftKey, query: slashQuery });
  }, [draftKey, slashQuery]);
  const composerDisabled = disabled || commandInFlight;

  const textareaProps: ComposerTextareaProps = {
    textareaRef,
    pendingCaretRef,
    isComposingRef,
    value: draft,
    disabled: composerDisabled,
    placeholder,
    mode,
    menuId,
    focusToken,
    mention,
    slashCommand: {
      active: slashCommandVisible,
      choose: chooseSlashCommand,
      dismiss: dismissSlashCommand,
      menuId: slashMenuId,
      optionId: slashOptionId,
    },
    onDraftChange: updateDraft,
    onSubmit: submit,
    onAddFiles: addDraftFiles,
    onCompositionChange: setIsComposing,
    notify,
  };

  return (
    <form
      className="composer"
      aria-busy={commandInFlight}
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
          disabled={composerDisabled}
          busy={commandInFlight}
          fileInputRef={fileInputRef}
          onFileChange={onFileChange}
          textarea={textareaProps}
          slashCommand={{
            visible: slashCommandVisible,
            onChoose: chooseSlashCommand,
            menuId: slashMenuId,
            optionId: slashOptionId,
          }}
        />
        {selectedFiles.length ? <ComposerFiles files={selectedFiles} onRemove={removeFile} /> : null}
        <ComposerHint />
      </div>
    </form>
  );
}
