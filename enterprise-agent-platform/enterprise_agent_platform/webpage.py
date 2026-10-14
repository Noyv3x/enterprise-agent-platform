"""Page text extraction for `web_fetch`: HTML → title and Markdown, in linear time.

Pages are hostile input. Every pattern here is linear in the input; what remains superlinear or recursive in the
third-party parsers (html.parser on malformed markup, markdownify's per-node regexes and recursion) is contained by
running the conversion as `python -m enterprise_agent_platform.webpage [charset]` (markup on stdin, JSON on stdout) in a
child process that Platform kills after a hard deadline (`tools.convert_page`).
"""
import codecs
import json
import re
import resource
import sys

from bs4 import BeautifulSoup, NavigableString
from markdownify import markdownify

CHILD_MEMORY = 1024 * 1024 * 1024
CHILD_CPU_SECONDS = 15

PARSE_CHARS = 2 * 1024 * 1024  # markup converted once scripts and styles are dropped (home pages carry megabytes of inline JSON)
WHITESPACE_RUN = 32  # longer whitespace runs inside text are cut to this (markdownify's own patterns backtrack over them)
EXCERPT_SCAN = 64 * 1024
BLOCK_OPEN = {str: re.compile(r'<(script|style)(?=[\s/>])', re.I), bytes: re.compile(rb'<(script|style)(?=[\s/>])', re.I)}
BLOCK_CLOSE = {kind: {name: re.compile(f'</{name}'.encode() if kind is bytes else f'</{name}', re.I) for name in ('script', 'style')}
               for kind in (str, bytes)}
LONG_WHITESPACE = re.compile(r'\s{%d,}' % (WHITESPACE_RUN + 1))
SURROGATE = re.compile('[\ud800-\udfff]')


def charset_name(label):
    """The codec name of a declared charset, or None when Python does not know it (`x-gbk`, garbage)."""
    if not isinstance(label, str) or not label.strip():
        return None
    try:
        return codecs.lookup(label.strip()).name
    except (LookupError, ValueError):
        return None


def clean(text):
    """Text with lone surrogates (from a browser's JavaScript strings, or a slice cutting a pair) replaced."""
    return SURROGATE.sub('\ufffd', text) if isinstance(text, str) else ''


def strip_blocks(markup):
    """`markup` (str or bytes) without <script> and <style> blocks, in one forward pass; an unclosed block drops the rest."""
    kind = type(markup)
    opener, closers = BLOCK_OPEN[kind], BLOCK_CLOSE[kind]
    parts, position = [], 0
    while (found := opener.search(markup, position)) is not None:
        parts.append(markup[position:found.start()])
        name = found.group(1).lower()
        closing = closers[name.decode() if kind is bytes else name].search(markup, found.end())
        if closing is None:
            return markup[:0].join(parts)
        end = markup.find(b'>' if kind is bytes else '>', closing.end())
        if end < 0:
            return markup[:0].join(parts)
        position = end + 1
    parts.append(markup[position:])
    return markup[:0].join(parts)


def tidy(text):
    """Whitespace-only lines emptied and runs of blank lines collapsed to one, line by line."""
    lines, blank = [], False
    for line in text.split('\n'):
        if line.strip(' \t\r'):
            lines.append(line)
            blank = False
        elif not blank and lines:
            lines.append('')
            blank = True
    return '\n'.join(lines).strip()


def drop_images(text):
    """Markdown `![alt](src)` images removed in one forward pass: every search starts past the previous match."""
    parts, position = [], 0
    while (start := text.find('![', position)) >= 0:
        middle = text.find('](', start + 2)
        if middle < 0:
            break
        end = text.find(')', middle + 2)
        if end < 0:
            break
        start = text.rfind('![', start, middle)  # the image is the last `![` before its `](`
        parts.append(text[position:start])
        position = end + 1
    parts.append(text[position:])
    return ''.join(parts)


def excerpt(text, limit):
    return tidy(drop_images(text[:EXCERPT_SCAN]))[:limit]


def shorten_whitespace(document):
    for node in document.find_all(string=True):
        if type(node) is NavigableString and len(node) > WHITESPACE_RUN and LONG_WHITESPACE.search(node):
            node.replace_with(NavigableString(LONG_WHITESPACE.sub(lambda run: run.group(0)[:WHITESPACE_RUN], node)))


def html_page(markup, charset=None):
    """`{title, text, noscript}` of HTML bytes or text: scripts, styles and noscript removed, then Markdown. A page too
    deeply nested for markdownify's recursion falls back to its plain text."""
    markup = strip_blocks(markup)[:PARSE_CHARS]
    document = BeautifulSoup(markup, 'html.parser', from_encoding=charset) if isinstance(markup, bytes) else BeautifulSoup(markup, 'html.parser')
    title = clean(document.title.get_text(' ', strip=True)) if document.title else ''
    noscript = document.find('noscript') is not None
    for element in document(['script', 'style', 'noscript']):
        element.decompose()
    shorten_whitespace(document)
    try:
        text = markdownify(str(document))
    except RecursionError:
        text = document.get_text('\n')
    text = tidy(clean(text))
    return {'title': title, 'text': text, 'noscript': noscript}


def main():
    """Child entry: bounded memory and CPU, markup bytes on stdin, `{title, text, noscript}` (or `{error}`) as JSON on stdout."""
    resource.setrlimit(resource.RLIMIT_AS, (CHILD_MEMORY, CHILD_MEMORY))
    resource.setrlimit(resource.RLIMIT_CPU, (CHILD_CPU_SECONDS, CHILD_CPU_SECONDS))
    markup = sys.stdin.buffer.read()
    try:
        outcome = html_page(markup, charset_name(sys.argv[1] if len(sys.argv) > 1 else None))
    except Exception as exc:  # any parser failure is a classified result, never a crash of the caller
        outcome = {'error': type(exc).__name__}
    sys.stdout.write(json.dumps(outcome))


if __name__ == '__main__':
    main()
