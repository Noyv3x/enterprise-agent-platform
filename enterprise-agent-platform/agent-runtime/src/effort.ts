import { createHash } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { clampThinkingLevel, type Api, type Model } from '@earendil-works/pi-ai';

// Reasoning depth levels the judge may choose, lowest to highest.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];
export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}
export const GPT6 = /^gpt-6([.-]|$)/;
export function stableEffortApplies(model: Pick<Model<Api>, 'api' | 'id'>): boolean {
  return model.api === 'openai-codex-responses' && GPT6.test(model.id);
}

/** `configuration_update` input item; only `reasoning.effort` is updatable. */
export interface ConfigurationUpdateItem { type: 'configuration_update'; reasoning: { effort: string } }
interface AnchorableItem { type?: string | null; role?: string; id?: string | null; status?: string | null }
interface Transition {
  /** Input-array position the item is spliced into (before `input[index]`). */
  index: number;
  /** Fingerprint of `input[index - 1]` at record time; a mismatch means the history was rewritten. */
  anchor: string;
  effort: string;
}
interface State {
  version: 1;
  /** Model the plan was recorded for; a different model starts a new baseline. */
  model?: string;
  base?: string;
  current?: string;
  transitions: Transition[];
  /** Pi thinking level an already existing conversation was using before any plan existed. */
  seed?: string;
  /** Last effort a run applied (a label the judge could pick); fallback for failed judgments and compaction. */
  applied?: EffortLevel;
  /** Previous user request, bounded; lets the judge see what a short follow-up continues. */
  previous?: string;
  /** A subagent session is judged once. */
  judged?: boolean;
}

function resetPlan(state: Pick<State, 'base' | 'current' | 'transitions'>): void {
  delete state.base; delete state.current; state.transitions = [];
}

// Output-only lifecycle fields are excluded: a live response item carries id/status that the sanitized replay drops.
function anchorOf(input: readonly AnchorableItem[], index: number): string {
  if (index === 0) return '';
  const item = input[index - 1];
  if (!item) return '';
  const { id: _id, status: _status, ...stable } = item;
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 24);
}

/**
 * Pin the request-level effort to the session baseline and splice pending `configuration_update` items into `input`
 * (mutated in place). Ported from oh-my-pi's `planStableOpenAIEffort`; returns the effort to send at request level.
 */
export function planStableEffort(state: Pick<State, 'base' | 'current' | 'transitions'>, input: Array<AnchorableItem | ConfigurationUpdateItem>, requested: string): string {
  for (const transition of state.transitions) {
    if (transition.index > input.length || transition.anchor !== anchorOf(input, transition.index)) {
      resetPlan(state);
      break;
    }
  }
  if (state.base === undefined) {
    state.base = requested; state.current = requested;
    return requested;
  }
  if (state.current !== requested) {
    const last = input[input.length - 1];
    const index = last && 'role' in last && last.role === 'user' ? input.length - 1 : input.length;
    const existing = state.transitions.find(transition => transition.index === index);
    if (existing) existing.effort = requested;
    else state.transitions.push({ index, anchor: anchorOf(input, index), effort: requested });
    // A change back to the effort already in force at that position is a no-op on the wire.
    let preceding = state.base;
    let precedingIndex = -1;
    for (const transition of state.transitions) {
      if (transition.index < index && transition.index > precedingIndex) { preceding = transition.effort; precedingIndex = transition.index; }
    }
    if (requested === preceding) state.transitions = state.transitions.filter(transition => transition.index !== index);
    state.current = requested;
  }
  // Ascending order so each insertion offsets only the later ones. Two updates are never adjacent: distinct indexes have an item between.
  state.transitions.sort((a, b) => a.index - b.index);
  let offset = 0;
  for (const transition of state.transitions) {
    input.splice(transition.index + offset, 0, { type: 'configuration_update', reasoning: { effort: transition.effort } });
    offset++;
  }
  return state.base;
}

// The effort string Pi's Codex request builder would put on the wire for a thinking level.
function wireEffort(model: Model<Api>, level: string): string {
  const clamped = clampThinkingLevel(model, level as Parameters<typeof clampThinkingLevel>[1]);
  const map = model.thinkingLevelMap as Record<string, string | null | undefined> | undefined;
  if (clamped === 'off') return map?.off === undefined || map.off === null ? 'none' : map.off;
  return map?.[clamped] ?? clamped;
}
function hasHistory(input: readonly AnchorableItem[]): boolean {
  return input.some(item => item.role === 'assistant' || item.type === 'function_call' || item.type === 'reasoning');
}

const str = (value: unknown): value is string => typeof value === 'string';
// Anything malformed is treated as absent; a damaged file never breaks the session.
function validState(raw: unknown): State | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || !Array.isArray(r.transitions)) return undefined;
  const transitions: Transition[] = [];
  for (const t of r.transitions) {
    if (!t || typeof t !== 'object') return undefined;
    const { index, anchor, effort } = t as Record<string, unknown>;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || !str(anchor) || !str(effort)) return undefined;
    transitions.push({ index, anchor, effort });
  }
  const state: State = { version: 1, transitions };
  for (const key of ['model', 'base', 'current', 'seed', 'previous'] as const) {
    if (r[key] === undefined) continue;
    if (!str(r[key])) return undefined;
    state[key] = r[key];
  }
  if (isEffortLevel(r.applied)) state.applied = r.applied;
  if (r.judged === true) state.judged = true;
  return state;
}

/** Per-session effort state, persisted next to the journal (`sessions-v3/<sha256(sid)>.effort.json`). */
export class EffortStore {
  readonly existed: boolean;
  private state: State;
  private saved: string;
  constructor(private readonly file: string) {
    let loaded: State | undefined;
    try {
      loaded = validState(JSON.parse(readFileSync(file, 'utf8')));
    } catch { /* absent or damaged: start without a plan, as a new conversation would */ }
    this.existed = loaded !== undefined;
    this.state = loaded ?? { version: 1, transitions: [] };
    this.saved = this.existed ? JSON.stringify(this.state) : '';
  }
  get applied(): EffortLevel | undefined { return isEffortLevel(this.state.applied) ? this.state.applied : undefined; }
  get previous(): string | undefined { return this.state.previous; }
  get judged(): boolean { return this.state.judged === true; }
  get baseline(): string | undefined { return this.state.base; }
  /** An existing conversation without a plan baselines on the effort its history already used. */
  seed(level: string): void {
    if (this.state.base === undefined && this.state.seed === undefined) { this.state.seed = level; this.save(); }
  }
  record(update: { applied?: string; previous?: string; judged?: boolean }): void {
    if (isEffortLevel(update.applied)) this.state.applied = update.applied;
    if (update.previous !== undefined) this.state.previous = update.previous;
    if (update.judged !== undefined) this.state.judged = update.judged;
    this.save();
  }
  /** Mutates a Codex request body in place; other APIs and models are untouched. */
  plan(model: Model<Api>, body: unknown): void {
    if (!stableEffortApplies(model) || !body || typeof body !== 'object') return;
    const request = body as { reasoning?: { effort?: unknown }; input?: unknown };
    const reasoning = request.reasoning;
    const requested = reasoning?.effort;
    if (!reasoning || typeof requested !== 'string' || !Array.isArray(request.input)) return;
    const state = this.state;
    try {
      const input = [...request.input];
      this.apply(state, model, input, reasoning, requested);
      request.input = input;
    } catch {
      // A damaged plan must not fail the request: drop it and send the request as built.
      resetPlan(state); delete state.seed;
      try { this.save(); } catch { /* best effort */ }
    }
  }
  private apply(state: State, model: Model<Api>, input: unknown[], reasoning: { effort?: unknown }, requested: string): void {
    // `none` is not a tier an update item can carry: send the request as built and keep the plan as it was.
    if (requested === 'none') return;
    if (state.model !== undefined && state.model !== model.id) resetPlan(state);
    state.model = model.id;
    if (state.base === undefined && state.seed !== undefined && hasHistory(input as AnchorableItem[])) {
      const wire = wireEffort(model, state.seed);
      if (wire !== 'none') { state.base = wire; state.current = wire; }
    }
    delete state.seed;
    reasoning.effort = planStableEffort(state, input as AnchorableItem[], requested);
    this.save();
  }
  private save(): void {
    const json = JSON.stringify(this.state);
    if (json === this.saved) return;
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, json, { mode: 0o600 });
    renameSync(temporary, this.file);
    this.saved = json;
  }
  /** Deleted together with the session. */
  remove(): void {
    rmSync(this.file, { force: true });
    this.saved = '';
  }
}
