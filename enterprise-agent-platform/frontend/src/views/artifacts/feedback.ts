/** 圈选反馈 (frontend.md § Artifacts): elements, regions and quotes picked in the 作品 panel, waiting in the composer as
 * a screenshot chip plus a context chip, and sent with the message as `artifact_feedback`. */
import { useCallback, useMemo, useRef, useState } from "react";
import { request, type ArtifactFeedback } from "../../api";
import type { Attachment, Message } from "../conversation/types";
import { errorText } from "../conversation/useConversation";
import type { Words } from "../conversation/work";

/** At most this many contexts wait in the composer. */
export const MAX_FEEDBACK = 5;
/** A quote keeps this many characters (an element's text arrives already cut to 300). */
export const QUOTE_MAX = 1000;

export type FeedbackRect = NonNullable<ArtifactFeedback["rect"]>;

/** An `eap-pick` from the page runtime: `rect` in document pixels, `path` relative to the artifact root. */
export interface FramePick {
  kind: "element" | "region";
  selector?: string;
  tag?: string;
  text?: string;
  rect: FeedbackRect;
  path: string;
  viewport: { w: number; h: number };
}

/** The screenshot of a picked spot: being rendered, attached, or failed (the context still goes). */
export type FeedbackShot = { state: "capturing" } | { state: "ready"; attachment: Attachment } | { state: "error"; error: string };

export interface FeedbackItem {
  key: string;
  feedback: ArtifactFeedback;
  /** the element's tag, for the chip */
  tag?: string;
  shot: FeedbackShot | null;
}

/** What the panel adds: the item and, for a page pick, the capture request that renders its screenshot. */
export interface FeedbackInput {
  feedback: ArtifactFeedback;
  tag?: string;
  capture?: { path: string; body: { path: string; rect: FeedbackRect; viewport: { w: number; h: number } } };
}

/** The panel's side of the feedback: how many wait, and adding one (false when MAX_FEEDBACK already wait). */
export interface FeedbackSink {
  count: number;
  add: (input: FeedbackInput) => boolean;
  /** phones: closes the panel sheet so the person can write in the composer */
  toComposer?: () => void;
}

export interface FeedbackState {
  items: FeedbackItem[];
  add: (input: FeedbackInput) => boolean;
  /** `shot` drops only the screenshot; `item` drops the context and its screenshot */
  remove: (key: string, part: "item" | "shot") => void;
  /** drops the items a sent message carried (others may have been added while it was sending) */
  sent: (keys: string[]) => void;
  /** puts back the contexts of a withdrawn message (without screenshots: those return as its attachments), as many as
   * still fit under MAX_FEEDBACK; returns how many did not fit */
  restore: (feedback: ArtifactFeedback[]) => number;
}

/** The conversation's waiting feedback. A screenshot is captured as a pending upload of the user's, like a composer
 * upload; a dropped one is simply not sent. */
export function useArtifactFeedback(): FeedbackState {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const next = useRef(0);
  const count = useRef(0);
  count.current = items.length;

  const add = useCallback((input: FeedbackInput) => {
    if (count.current >= MAX_FEEDBACK) return false;
    count.current += 1;
    const key = `feedback-${next.current++}`;
    const { capture, ...rest } = input;
    setItems((current) => [...current, { ...rest, key, shot: capture ? { state: "capturing" } : null }]);
    if (capture) {
      const settle = (shot: FeedbackShot) =>
        setItems((current) => current.map((item) => (item.key === key && item.shot ? { ...item, shot } : item)));
      request<{ attachment: Attachment }>(capture.path, { method: "POST", body: JSON.stringify(capture.body) }).then(
        ({ attachment }) => settle({ state: "ready", attachment }),
        (reason: unknown) => settle({ state: "error", error: errorText(reason) }),
      );
    }
    return true;
  }, []);

  const remove = useCallback((key: string, part: "item" | "shot") => {
    setItems((current) => (part === "item"
      ? current.filter((item) => item.key !== key)
      : current.map((item) => (item.key === key ? { ...item, shot: null } : item))));
  }, []);

  const sent = useCallback((keys: string[]) => setItems((current) => current.filter((item) => !keys.includes(item.key))), []);

  const restore = useCallback((feedback: ArtifactFeedback[]) => {
    const fitting = feedback.slice(0, Math.max(0, MAX_FEEDBACK - count.current));
    count.current += fitting.length;
    const restored = fitting.map((item): FeedbackItem => ({ key: `feedback-${next.current++}`, feedback: item, shot: null }));
    if (restored.length) setItems((current) => [...current, ...restored]);
    return feedback.length - fitting.length;
  }, []);

  return useMemo(() => ({ items, add, remove, sent, restore }), [items, add, remove, sent, restore]);
}

/** Ids of the attached screenshots, sent with the message's attachments. */
export function feedbackAttachmentIds(items: FeedbackItem[]): number[] {
  return items.flatMap((item) => (item.shot?.state === "ready" ? [item.shot.attachment.id] : []));
}

/** The message's `artifact_feedback`: Platform adds the artifact's title and kind from its own records. */
export function feedbackPayload(items: FeedbackItem[]): ArtifactFeedback[] {
  return items.map(({ feedback: { title: _title, artifact_kind: _kind, ...item } }) => item);
}

const KINDS: Record<ArtifactFeedback["kind"], true> = { element: true, region: true, quote: true };

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Stored feedback items (`metadata.artifact_feedback`, a withdrawal's `artifact_feedback`); malformed entries are
 * skipped, and only the fields a message sends plus the title and kind are kept. */
export function feedbackItems(raw: unknown): ArtifactFeedback[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): ArtifactFeedback[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.artifact_id !== "number" || typeof item.kind !== "string" || !KINDS[item.kind as ArtifactFeedback["kind"]]) return [];
    const rect = item.rect as Record<string, unknown> | null | undefined;
    const parsed: ArtifactFeedback = {
      artifact_id: item.artifact_id,
      version: typeof item.version === "number" ? item.version : null,
      path: typeof item.path === "string" ? item.path : "",
      kind: item.kind as ArtifactFeedback["kind"],
    };
    if (typeof item.selector === "string") parsed.selector = item.selector;
    if (typeof item.text === "string") parsed.text = item.text;
    if (rect && finite(rect.x) && finite(rect.y) && finite(rect.w) && finite(rect.h)) parsed.rect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    if (typeof item.title === "string") parsed.title = item.title;
    if (typeof item.artifact_kind === "string") parsed.artifact_kind = item.artifact_kind as ArtifactFeedback["artifact_kind"];
    return [parsed];
  });
}

/** The feedback a user message carried (`metadata.artifact_feedback`). */
export function messageFeedback(message: Message): ArtifactFeedback[] {
  return feedbackItems(message.metadata.artifact_feedback);
}

/** 「Launch deck v3 · h2 · Pricing that…」: the artifact, what was picked and a short excerpt. An element without a known
 * tag reads its selector's last tag. */
export function feedbackLabel(feedback: ArtifactFeedback, w: Words, tag?: string): string {
  const title = feedback.title || w("Artifact", "作品", "作品");
  const head = feedback.version === null ? title : `${title} v${feedback.version}`;
  const selectorTag = /^[a-z][a-z0-9-]*/i.exec((feedback.selector ?? "").split(/[\s>+~]+/).pop() ?? "")?.[0];
  const target = feedback.kind === "region" ? w("Region", "区域", "區域")
    : feedback.kind === "quote" ? w("Quote", "引用", "引用")
      : (tag || selectorTag)?.toLowerCase() || w("Element", "元素", "元素");
  const text = feedback.text?.replace(/\s+/g, " ").trim() ?? "";
  const excerpt = text.length > 18 ? `${text.slice(0, 18)}…` : text;
  return [head, target, excerpt].filter(Boolean).join(" · ");
}
