import { describe, expect, it } from 'vitest';
import { formatThinking } from './thinking';

describe('formatThinking', () => {
  it('removes empty summary sentinels and their trailing partial while preserving both headline parts', () => {
    const first = '**Inspecting packages**\n\n<!--';
    expect(formatThinking(first)).toBe('**Inspecting packages**');
    expect(formatThinking(`${first} -->\n\nChecking dependencies.\n\n**Choosing a fix**\n\n<!-- -->\n\nKeep the existing API.`))
      .toBe('**Inspecting packages**\n\n\nChecking dependencies.\n\n**Choosing a fix**\n\n\nKeep the existing API.');
  });

  it.each(['```', '~~~~'])('keeps complete and partial comments inside %s code fences', (fence) => {
    const code = `${fence}html\n<!-- -->\n<!--\n${fence}`;
    expect(formatThinking(`<!-- -->\n${code}\n<!--`)).toBe(code);
  });

  it('requires a matching fence character, length and empty closing suffix', () => {
    const code = '````html\n```\n<!-- -->\n~~~~\n<!-- -->\n````not a closer\n<!-- -->\n````';
    expect(formatThinking(`${code}\n<!-- -->`)).toBe(code);
  });

  it('preserves nonempty comments and non-trailing partial comments', () => {
    const text = '<!-- explain this -->\n<!--\nnot an empty sentinel';
    expect(formatThinking(text)).toBe(text);
  });

  it('does not mistake inline backticks for a code fence', () => {
    expect(formatThinking('```inline```\n<!-- -->\nVisible')).toBe('```inline```\nVisible');
  });

  it.each(['', ' \t\r\n', '.', '... … .', '<!-- -->\n…\n<!--'])('hides placeholder-only text %j', (text) => {
    expect(formatThinking(text)).toBe('');
  });

  it('retains useful prose and code containing ellipses', () => {
    expect(formatThinking(' Checking… ')).toBe('Checking…');
    expect(formatThinking('```\n...\n```')).toBe('```\n...\n```');
  });
});
