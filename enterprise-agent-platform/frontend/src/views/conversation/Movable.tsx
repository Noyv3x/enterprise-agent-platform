import { Component, createRef, type ReactNode } from "react";
import { EASE_OUT_STRONG, GLIDE_MS, LEAVE_MS, reducedMotion } from "./motion";

/** Where a moving bubble last stood (scroll-content coordinates) when its row unmounted, for the same message's next
 * mount in the same commit: an undelivered insert requeued at turn end leaves the reply for the FIFO area. */
const departed = new Map<number, { slot: string; top: number }>();

interface MovableProps {
  messageId: number;
  /** the bubble's place in the conversation (pending, delivered, queued…); a change glides it from its old position */
  slot: string;
  /** play the entrance: a message that arrived after the first page */
  enter: boolean;
  /** withdrawn: collapse away */
  leaving: boolean;
  className?: string;
  children: ReactNode;
}

/** One user message's container. A changed slot keeps the DOM node and glides from the old position (FLIP); a slot
 * change across parents hands the position to the new mount, which glides instead of replaying its entrance; a
 * withdrawn bubble collapses its height, padding and the flex gap beside it. Reduced motion makes all of it instant.
 * A class component because only getSnapshotBeforeUpdate reads layout before React moves the node. */
export class Movable extends Component<MovableProps> {
  private readonly node = createRef<HTMLDivElement>();

  private top(): number | null {
    const node = this.node.current;
    if (!node) return null;
    const scroller = node.closest<HTMLElement>("[role='log']");
    return node.getBoundingClientRect().top + (scroller ? scroller.scrollTop - scroller.getBoundingClientRect().top : 0);
  }

  private play(keyframes: Keyframe[], options: KeyframeAnimationOptions): void {
    const node = this.node.current;
    if (!node || typeof node.animate !== "function" || reducedMotion()) return;
    node.animate(keyframes, { easing: EASE_OUT_STRONG, ...options });
  }

  private glide(from: number): void {
    const to = this.top();
    if (to === null || Math.abs(from - to) < 1) return;
    this.play([{ transform: `translateY(${from - to}px)` }, { transform: "translateY(0)" }], { duration: GLIDE_MS });
  }

  private collapse(): void {
    const node = this.node.current;
    if (!node) return;
    const style = getComputedStyle(node);
    const gap = node.parentElement ? Number.parseFloat(getComputedStyle(node.parentElement).rowGap) || 0 : 0;
    const edge = node.nextElementSibling ? "marginBottom" : node.previousElementSibling ? "marginTop" : null;
    node.style.overflow = "hidden";
    this.play([
      { height: `${node.offsetHeight}px`, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, opacity: 1, ...(edge ? { [edge]: "0px" } : {}) },
      { height: "0px", paddingTop: "0px", paddingBottom: "0px", opacity: 0, ...(edge ? { [edge]: `${-gap}px` } : {}) },
    ], { duration: LEAVE_MS, fill: "forwards" });
  }

  componentDidMount(): void {
    const from = departed.get(this.props.messageId);
    departed.delete(this.props.messageId);
    if (from) {
      if (from.slot !== this.props.slot) this.glide(from.top);
    } else if (this.props.enter && !this.props.leaving) {
      this.play([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 300 });
    }
    if (this.props.leaving) this.collapse();
  }

  getSnapshotBeforeUpdate(previous: MovableProps): number | null {
    return previous.slot !== this.props.slot ? this.top() : null;
  }

  componentDidUpdate(previous: MovableProps, _state: unknown, from: number | null): void {
    if (from !== null) this.glide(from);
    if (this.props.leaving && !previous.leaving) this.collapse();
  }

  componentWillUnmount(): void {
    const top = this.top();
    if (top === null || this.props.leaving) return;
    const { messageId, slot } = this.props;
    departed.set(messageId, { slot, top });
    // Only a mount in this same commit may claim it.
    queueMicrotask(() => {
      if (departed.get(messageId)?.top === top) departed.delete(messageId);
    });
  }

  render(): ReactNode {
    return <div ref={this.node} className={this.props.className}>{this.props.children}</div>;
  }
}
