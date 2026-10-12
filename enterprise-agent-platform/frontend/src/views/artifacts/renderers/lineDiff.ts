/** Line diff of two text versions, as the unified diff the CodeBlock Diff variant renders. */

type Op = 0 | 1 | 2; // equal, delete (old line), insert (new line)
const EQUAL = 0;
const DELETE = 1;
const INSERT = 2;

/** Above this many edits in the changed middle, the middle shows as replaced instead of a minimal script; this bounds
 * the trace at O(MAX_EDITS²) memory and O((N+M)·MAX_EDITS) time. */
const MAX_EDITS = 1500;

function lines(text: string): string[] {
  if (text === "") return [];
  const list = text.split(/\r\n|\n|\r/);
  if (list[list.length - 1] === "") list.pop();
  return list;
}

/** Myers' O((N+M)·D) shortest edit script over interned lines; `null` when more than MAX_EDITS edits are needed. */
function myers(a: Int32Array, b: Int32Array): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return null;

  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d]; // V before step d, indexed from k = -d - 1
    const at = (k: number) => prev[k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push(EQUAL); x--; y--; }
    ops.push(down ? INSERT : DELETE);
    if (down) y--; else x--;
  }
  while (x > 0 && y > 0) { ops.push(EQUAL); x--; y--; }
  return ops.reverse();
}

/** The edit script from `before` to `after`, line by line. */
function editScript(before: string[], after: string[]): Op[] {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;

  const ids = new Map<string, number>();
  const intern = (list: string[]) => Int32Array.from(list.slice(head, list.length - tail), (line) => {
    let id = ids.get(line);
    if (id === undefined) ids.set(line, (id = ids.size));
    return id;
  });
  const a = intern(before);
  const b = intern(after);
  const middle = myers(a, b) ?? [...Array<Op>(a.length).fill(DELETE), ...Array<Op>(b.length).fill(INSERT)];
  return [...Array<Op>(head).fill(EQUAL), ...middle, ...Array<Op>(tail).fill(EQUAL)];
}

/** A unified diff (hunk headers and ` `/`-`/`+` rows, no file headers) from `before` to `after` with `context`
 * unchanged lines around each change; null when the texts have the same lines. */
export function unifiedDiff(before: string, after: string, context = 3): string | null {
  const a = lines(before);
  const b = lines(after);
  const ops = editScript(a, b);
  if (ops.every((op) => op === EQUAL)) return null;

  // Old/new line index at each op.
  const oldAt = new Int32Array(ops.length + 1);
  const newAt = new Int32Array(ops.length + 1);
  ops.forEach((op, i) => {
    oldAt[i + 1] = oldAt[i] + (op === INSERT ? 0 : 1);
    newAt[i + 1] = newAt[i] + (op === DELETE ? 0 : 1);
  });

  const out: string[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i] === EQUAL) { i++; continue; }
    // A hunk: changes joined while fewer than 2·context equal lines separate them.
    const start = Math.max(0, i - context);
    let end = i;
    let equalRun = 0;
    for (let j = i; j < ops.length; j++) {
      if (ops[j] === EQUAL) {
        equalRun++;
        if (equalRun > 2 * context) break;
      } else {
        equalRun = 0;
        end = j + 1;
      }
    }
    const stop = Math.min(ops.length, end + context);
    const oldCount = oldAt[stop] - oldAt[start];
    const newCount = newAt[stop] - newAt[start];
    const oldStart = oldCount ? oldAt[start] + 1 : oldAt[start];
    const newStart = newCount ? newAt[start] + 1 : newAt[start];
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let j = start; j < stop; j++) {
      const op = ops[j];
      out.push(op === EQUAL ? ` ${b[newAt[j]]}` : op === DELETE ? `-${a[oldAt[j]]}` : `+${b[newAt[j]]}`);
    }
    i = stop;
  }
  return out.join("\n");
}
