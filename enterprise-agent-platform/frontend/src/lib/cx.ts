/* className join helper — accepts strings, falsey values, and nested arrays.
   Replaces the legacy template-literal class concatenation while keeping the
   exact global class-name contract intact. */

export type ClassValue = string | number | null | undefined | false | ClassValue[];

export function cx(...args: ClassValue[]): string {
  const out: string[] = [];
  for (const arg of args) {
    if (!arg) continue;
    if (Array.isArray(arg)) {
      const inner = cx(...arg);
      if (inner) out.push(inner);
    } else {
      out.push(String(arg));
    }
  }
  return out.join(" ");
}
