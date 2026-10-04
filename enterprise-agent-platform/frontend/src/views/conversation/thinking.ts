/** omp's thinking-display essentials: remove summary sentinel lines outside Markdown fences,
 * including a trailing partial sentinel, and hide dot/ellipsis-only placeholders. Code stays verbatim.
 * The view memoizes this per block, so unchanged summaries are not rescanned on stream/clock ticks. */
export function formatThinking(text: string): string {
  let formatted = text;
  if (text.includes("<!--")) {
    const lines = text.split("\n");
    const visible: string[] = [];
    let fence = "";
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = "";
      } else {
        const trimmed = line.trim();
        if (/^<!--\s*-->$/.test(trimmed) || (index === lines.length - 1 && /^<!--\s*$/.test(trimmed))) continue;
        // Backtick fences cannot have a backtick in their info string.
        if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) fence = marker[1];
      }
      visible.push(line);
    }
    formatted = visible.join("\n");
  }
  return /^[.\u2026\s]*$/.test(formatted) ? "" : formatted.trim();
}
