#!/usr/bin/env python3
"""Read-only repository size metrics: files, languages, code/comment/blank lines.

Standard library only; makes no network calls and writes nothing. Counts are
descriptive signals, not measures of productivity or quality.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

DEFAULT_EXCLUDES = (
    ".git .hg .svn node_modules venv .venv env __pycache__ .cache dist build out target .next .nuxt "
    ".tox .eggs .mypy_cache .pytest_cache .ruff_cache .idea .vscode coverage htmlcov vendor "
    "third_party bower_components .gradle .terraform .agent-platform"
).split()
MAX_FILE_BYTES = 2 * 1024 * 1024
GENERATED_NAMES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "uv.lock", "Cargo.lock",
    "Gemfile.lock", "composer.lock", "go.sum",
}

# language: (extensions or names, line-comment prefixes, block-comment (start, end) or None)
C = (("//",), ("/*", "*/"))
HASH = (("#",), None)
LANGS: dict[str, tuple[tuple[str, ...], tuple[str, ...], tuple[str, str] | None]] = {
    "Python": ((".py", ".pyi"), ("#",), None),
    "JavaScript": ((".js", ".jsx", ".mjs", ".cjs"), *C),
    "TypeScript": ((".ts", ".tsx", ".mts", ".cts"), *C),
    "Java": ((".java",), *C),
    "Kotlin": ((".kt", ".kts"), *C),
    "Go": ((".go",), *C),
    "Rust": ((".rs",), *C),
    "C": ((".c", ".h"), *C),
    "C++": ((".cc", ".cpp", ".cxx", ".hpp", ".hh"), *C),
    "C#": ((".cs",), *C),
    "Swift": ((".swift",), *C),
    "PHP": ((".php",), ("//", "#"), ("/*", "*/")),
    "Ruby": ((".rb",), ("#",), None),
    "Shell": ((".sh", ".bash", ".zsh"), ("#",), None),
    "SQL": ((".sql",), ("--",), ("/*", "*/")),
    "Lua": ((".lua",), ("--",), ("--[[", "]]")),
    "HTML": ((".html", ".htm"), (), ("<!--", "-->")),
    "CSS": ((".css", ".scss", ".less"), ("//",), ("/*", "*/")),
    "Vue": ((".vue", ".svelte"), (), ("<!--", "-->")),
    "YAML": ((".yml", ".yaml"), ("#",), None),
    "TOML": ((".toml",), ("#",), None),
    "JSON": ((".json", ".jsonc"), (), None),
    "XML": ((".xml", ".svg"), (), ("<!--", "-->")),
    "Dockerfile": (("Dockerfile",), ("#",), None),
    "Makefile": (("Makefile", ".mk"), ("#",), None),
}
DOC_EXTS = {".md": "Markdown", ".markdown": "Markdown", ".rst": "reStructuredText", ".txt": "Text"}
BY_EXT: dict[str, str] = {}
BY_NAME: dict[str, str] = {}
for _lang, (_keys, _l, _b) in LANGS.items():
    for _key in _keys:
        (BY_EXT if _key.startswith(".") else BY_NAME)[_key] = _lang


def list_files(root: Path, excludes: set[str], use_git: bool) -> tuple[list[Path], str]:
    if use_git:
        try:
            out = subprocess.run(
                ["git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                capture_output=True, check=True, timeout=60,
            ).stdout
            paths = [root / p for p in out.decode("utf-8", "replace").split("\0") if p]
            keep = [p for p in paths if not (excludes & set(p.relative_to(root).parts[:-1]))]
            return [p for p in keep if p.is_file() and not p.is_symlink()], "git (tracked and unignored files)"
        except (OSError, subprocess.SubprocessError):
            pass
    found: list[Path] = []
    for base, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in excludes)
        found.extend(Path(base, n) for n in sorted(names) if not Path(base, n).is_symlink())
    return found, "directory walk"


def classify(path: Path) -> tuple[str | None, str]:
    if path.name in BY_NAME:
        return BY_NAME[path.name], "code"
    suffix = path.suffix.lower()
    if suffix in BY_EXT:
        lang = BY_EXT[suffix]
        return lang, ("data" if lang in ("JSON", "YAML", "TOML", "XML") else "code")
    if suffix in DOC_EXTS:
        return DOC_EXTS[suffix], "doc"
    return None, "other"


def count_lines(text: str, lang: str, kind: str) -> tuple[int, int, int]:
    """Return (code, comment, blank). Docs count every non-blank line as documentation."""
    code = comment = blank = 0
    if kind == "doc":
        for line in text.splitlines():
            blank += not line.strip()
            comment += bool(line.strip())
        return 0, comment, blank
    _, line_marks, block = LANGS.get(lang, ((), (), None))
    in_block = False
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            blank += 1
        elif in_block:
            comment += 1
            if block and block[1] in line:
                in_block = False
        elif line_marks and line.startswith(line_marks):
            comment += 1
        elif block and line.startswith(block[0]):
            comment += 1
            if block[1] not in line[len(block[0]):]:
                in_block = True
        else:
            code += 1
    return code, comment, blank


def is_generated(path: Path, text: str) -> bool:
    if path.name in GENERATED_NAMES or path.name.endswith((".min.js", ".min.css", ".map")):
        return True
    lines = text.splitlines()
    return bool(lines) and path.suffix in (".js", ".css") and len(text) / len(lines) > 500


def inspect(root: Path, excludes: set[str], use_git: bool, by_dir: bool) -> dict:
    files, method = list_files(root, excludes, use_git)
    langs: dict[str, dict] = defaultdict(lambda: {"kind": "", "files": 0, "code": 0, "comment": 0, "blank": 0})
    dirs: dict[str, dict] = defaultdict(lambda: {"files": 0, "code": 0, "comment": 0, "blank": 0})
    skipped = {"binary": 0, "too_large": 0, "generated": 0, "unknown_text": 0, "unreadable": 0}
    for path in files:
        lang, kind = classify(path)
        try:
            if path.stat().st_size > MAX_FILE_BYTES:
                skipped["too_large"] += 1
                continue
            data = path.read_bytes()
        except OSError:
            skipped["unreadable"] += 1
            continue
        if b"\0" in data[:8192]:
            skipped["binary"] += 1
            continue
        text = data.decode("utf-8", "replace")
        if lang is None:
            skipped["unknown_text"] += 1
            continue
        if is_generated(path, text):
            skipped["generated"] += 1
            continue
        code, comment, blank = count_lines(text, lang, kind)
        row = langs[lang]
        row["kind"] = kind
        for key, value in (("files", 1), ("code", code), ("comment", comment), ("blank", blank)):
            row[key] += value
        if by_dir:
            rel = path.relative_to(root)
            top = rel.parts[0] if len(rel.parts) > 1 else "."
            for key, value in (("files", 1), ("code", code), ("comment", comment), ("blank", blank)):
                dirs[top][key] += value
    total = {k: sum(r[k] for r in langs.values()) for k in ("files", "code", "comment", "blank")}
    return {
        "root": str(root), "method": method, "excluded_dirs": sorted(excludes), "listed_files": len(files),
        "total": total, "languages": dict(sorted(langs.items(), key=lambda kv: -(kv[1]["code"] + kv[1]["comment"]))),
        "directories": dict(sorted(dirs.items(), key=lambda kv: -kv[1]["code"])), "not_counted": skipped,
    }


def render(report: dict) -> str:
    total = report["total"]
    lines = [
        f"Path: {report['root']}", f"File discovery: {report['method']}",
        f"Excluded directories: {', '.join(report['excluded_dirs'])}",
        f"Counted files: {total['files']} of {report['listed_files']} listed", "",
        f"{'Language':<18}{'Kind':<6}{'Files':>8}{'Code':>10}{'Comment/Doc':>13}{'Blank':>9}{'Code %':>8}",
    ]
    code_total = sum(r["code"] for r in report["languages"].values() if r["kind"] != "doc") or 1
    for name, row in report["languages"].items():
        pct = f"{100 * row['code'] / code_total:.1f}" if row["kind"] != "doc" else "-"
        lines.append(f"{name:<18}{row['kind']:<6}{row['files']:>8}{row['code']:>10}{row['comment']:>13}{row['blank']:>9}{pct:>8}")
    lines.append(f"{'Total':<24}{total['files']:>8}{total['code']:>10}{total['comment']:>13}{total['blank']:>9}")
    if report["directories"]:
        lines += ["", "Top-level directories (code lines):"]
        lines += [f"  {n:<30}{r['files']:>6} files{r['code']:>10} code" for n, r in report["directories"].items()]
    lines += ["", "Not counted: " + ", ".join(f"{k.replace('_', ' ')} {v}" for k, v in report["not_counted"].items())]
    lines.append("Markdown/rst/txt lines are counted as documentation, not code; JSON/YAML/TOML/XML are 'data' kind.")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("path", nargs="?", default=".", help="directory to inspect (default: current)")
    ap.add_argument("--exclude", default="", help="extra comma-separated directory names to skip")
    ap.add_argument("--no-default-excludes", action="store_true", help="count vendored/build directories too")
    ap.add_argument("--no-git", action="store_true", help="walk the directory instead of asking git")
    ap.add_argument("--by-dir", action="store_true", help="break code lines down by top-level directory")
    ap.add_argument("--json", action="store_true", help="print JSON instead of a table")
    args = ap.parse_args()
    root = Path(args.path).resolve()
    if not root.is_dir():
        print(f"error: not a directory: {args.path}", file=sys.stderr)
        return 2
    excludes = set() if args.no_default_excludes else set(DEFAULT_EXCLUDES)
    excludes |= {e.strip() for e in args.exclude.split(",") if e.strip()}
    report = inspect(root, excludes, not args.no_git, args.by_dir)
    print(json.dumps(report, ensure_ascii=False, indent=2) if args.json else render(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
