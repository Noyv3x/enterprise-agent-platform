/* useMention — the React port of the legacy @mention machine over a plain
   <textarea> (legacy-app.js:1031-1173). Channel-only.

   The legacy code drove an imperatively-mutated module singleton (`mentionState`)
   + a DOM menu. Here the live state lives in refs (so event handlers read the
   latest values synchronously, exactly like the mutable singleton) and a
   `forceRender` reducer re-renders the menu when those refs change.

   Caret correctness (plan §1.4 hazard #2): applyMention sets the controlled draft
   and stashes the desired caret in a pending-caret ref; <ComposerTextarea> applies
   it in a useLayoutEffect AFTER the new value commits (else the caret jumps to the
   end). Option selection fires on onMouseDown + preventDefault (not onClick) so the
   textarea keeps focus and the 120ms blur-hide never wins first. */

import { useCallback, useEffect, useReducer, useRef, type KeyboardEvent, type RefObject } from "react";
import type { ChatMode, MentionTarget } from "../types";

interface MentionRange {
  start: number;
  end: number;
  query: string;
}

/** Fallback single agent option when no targets are loaded (legacy :1042). */
const FALLBACK_TARGET: MentionTarget = {
  kind: "agent",
  handle: "agent",
  label: "Agent",
  description: "呼叫频道 Agent",
};

const MAX_OPTIONS = 8;
const BLUR_HIDE_MS = 120;

export interface UseMentionParams {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  mode: ChatMode;
  menuId: string;
  mentionTargets: MentionTarget[];
  isComposingRef: RefObject<boolean>;
  setDraft: (value: string) => void;
  setPendingCaret: (position: number) => void;
  notify: (isTyping: boolean) => void;
}

export interface MentionApi {
  active: boolean;
  options: MentionTarget[];
  selected: number;
  menuId: string;
  optionId: (index: number) => string;
  /** value for the textarea's aria-activedescendant (null when nothing active). */
  activeDescendant: string | null;
  /** recompute the popup from the textarea (input/focus/click/keyup). */
  update: () => void;
  /** keyboard nav handled BEFORE the Enter-to-send branch; true = consumed. */
  handleKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** select an option (onMouseDown). */
  choose: (index: number) => void;
  /** highlight an option (onMouseEnter). */
  hover: (index: number) => void;
  hide: () => void;
  /** delayed hide on blur, leaving room for an option onMouseDown to fire first. */
  scheduleHide: () => void;
}

export function useMention(params: UseMentionParams): MentionApi {
  const { textareaRef, mode, menuId, mentionTargets, isComposingRef, setDraft, setPendingCaret, notify } =
    params;

  const activeRef = useRef(false);
  const selectedRef = useRef(0);
  const optionsRef = useRef<MentionTarget[]>([]);
  const rangeRef = useRef<MentionRange | null>(null);
  const blurTimer = useRef<number | null>(null);
  const [, forceRender] = useReducer((count: number) => count + 1, 0);

  const optionId = useCallback((index: number) => `${menuId}-opt-${index}`, [menuId]);

  const hide = useCallback(() => {
    if (
      !activeRef.current &&
      !optionsRef.current.length &&
      selectedRef.current === 0 &&
      !rangeRef.current
    ) {
      return; // already hidden — don't churn a render
    }
    activeRef.current = false;
    selectedRef.current = 0;
    optionsRef.current = [];
    rangeRef.current = null;
    forceRender();
  }, []);

  const currentRange = useCallback((): MentionRange | null => {
    const input = textareaRef.current;
    if (!input) return null;
    const cursor = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, cursor);
    const match = before.match(/(^|[\s([{])@([A-Za-z0-9_.-]*)$/);
    if (!match) return null;
    const query = match[2] || "";
    return { start: before.length - query.length - 1, end: cursor, query: query.toLowerCase() };
  }, [textareaRef]);

  const computeOptions = useCallback(
    (query: string): MentionTarget[] => {
      const targets = mentionTargets.length ? mentionTargets : [FALLBACK_TARGET];
      return targets
        .filter((target) => {
          const haystack =
            `${target.handle || ""} ${target.label || ""} ${target.description || ""}`.toLowerCase();
          return !query || haystack.includes(query);
        })
        .slice(0, MAX_OPTIONS);
    },
    [mentionTargets],
  );

  const update = useCallback(() => {
    const input = textareaRef.current;
    if (mode !== "channel" || !input || input.disabled || isComposingRef.current) {
      hide();
      return;
    }
    const range = currentRange();
    if (!range) {
      hide();
      return;
    }
    const options = computeOptions(range.query);
    if (!options.length) {
      hide();
      return;
    }
    const previousQuery = rangeRef.current?.query;
    activeRef.current = true;
    selectedRef.current =
      previousQuery === range.query ? Math.min(selectedRef.current, options.length - 1) : 0;
    optionsRef.current = options;
    rangeRef.current = range;
    forceRender();
  }, [mode, textareaRef, isComposingRef, hide, currentRange, computeOptions]);

  const applyMention = useCallback(
    (index: number) => {
      const input = textareaRef.current;
      const option = optionsRef.current[index];
      const range = rangeRef.current || currentRange();
      if (!input || !option || !range) return;
      const insert = `@${option.handle} `;
      const next = `${input.value.slice(0, range.start)}${insert}${input.value.slice(range.end)}`;
      const cursor = range.start + insert.length;
      setDraft(next);
      setPendingCaret(cursor);
      notify(next.trim().length > 0);
      hide();
      input.focus();
    },
    [textareaRef, currentRange, setDraft, setPendingCaret, notify, hide],
  );

  const choose = useCallback(
    (index: number) => {
      selectedRef.current = index;
      applyMention(index);
    },
    [applyMention],
  );

  const hover = useCallback((index: number) => {
    selectedRef.current = index;
    forceRender();
  }, []);

  const handleKey = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (mode !== "channel") return false;
      if (!activeRef.current) update();
      if (!activeRef.current) return false;
      const options = optionsRef.current;
      if (!options.length) return false;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        selectedRef.current = (selectedRef.current + 1) % options.length;
        forceRender();
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        selectedRef.current = (selectedRef.current - 1 + options.length) % options.length;
        forceRender();
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        applyMention(selectedRef.current);
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        hide();
        return true;
      }
      return false;
    },
    [mode, update, applyMention, hide],
  );

  const scheduleHide = useCallback(() => {
    if (blurTimer.current != null) clearTimeout(blurTimer.current);
    blurTimer.current = window.setTimeout(() => {
      blurTimer.current = null;
      hide();
    }, BLUR_HIDE_MS);
  }, [hide]);

  useEffect(() => {
    return () => {
      if (blurTimer.current != null) clearTimeout(blurTimer.current);
    };
  }, []);

  const active = activeRef.current;
  const options = optionsRef.current;
  const selected = selectedRef.current;

  return {
    active,
    options,
    selected,
    menuId,
    optionId,
    activeDescendant: active && options.length ? optionId(selected) : null,
    update,
    handleKey,
    choose,
    hover,
    hide,
    scheduleHide,
  };
}
