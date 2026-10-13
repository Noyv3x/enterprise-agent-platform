#!/usr/bin/env python3
"""Validate a skill directory against the rules the Platform enforces on install, plus authoring hygiene.

Usage: python /opt/agent-platform/skills/builtin/skill-creator/scripts/validate_skill.py <skill-dir>
Exit 0 = installable (warnings may still print), 1 = the Platform would reject it.
Adapted from anthropics/skills skill-creator `quick_validate.py` (Apache-2.0); rules re-derived from the Platform's parser.
"""
import os
import re
import sys
from pathlib import Path

import yaml

MAX_NAME, MAX_DESCRIPTION, MAX_SKILL_MD, MAX_FILES, MAX_UNPACKED = 64, 1024, 256 * 1024, 2000, 50 * 1024 * 1024
NAME = re.compile(r'[a-z0-9]+(-[a-z0-9]+)*')
ALLOWED = {'name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools', 'disable-model-invocation', 'version', 'category', 'tags'}


def validate(path):
    errors, warnings = [], []
    root = Path(path)
    skill_md = root / 'SKILL.md'
    if not skill_md.is_file():
        return ['SKILL.md not found'], warnings
    raw = skill_md.read_bytes()
    if len(raw) > MAX_SKILL_MD:
        errors.append(f'SKILL.md is larger than {MAX_SKILL_MD // 1024} KiB')
    try:
        text = raw.decode('utf-8').removeprefix('\ufeff')
    except UnicodeError:
        return ['SKILL.md is not valid UTF-8'], warnings
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].rstrip() != '---':
        return errors + ['SKILL.md must start with a --- YAML frontmatter block'], warnings
    end = next((i for i in range(1, len(lines)) if lines[i].rstrip() == '---'), None)
    if end is None:
        return errors + ['Frontmatter is not closed with a --- line'], warnings
    body = ''.join(lines[end + 1:])
    try:
        meta = yaml.safe_load(''.join(lines[1:end])) or {}
        if not isinstance(meta, dict):
            raise yaml.YAMLError('frontmatter is not a mapping')
    except yaml.YAMLError as exc:
        return errors + [f'Frontmatter is not valid YAML (quote values containing ": "): {exc}'], warnings

    name = meta.get('name')
    if not isinstance(name, str) or not name.strip():
        errors.append('Frontmatter needs a name')
    else:
        name = name.strip()
        if not NAME.fullmatch(name) or len(name) > MAX_NAME:
            errors.append(f'name "{name}" must be 1-{MAX_NAME} characters: lowercase a-z, 0-9, single hyphens')
        if name != root.resolve().name:
            warnings.append(f'name "{name}" differs from the directory name "{root.resolve().name}"')
    description = meta.get('description')
    if not isinstance(description, str) or not description.strip():
        errors.append('Frontmatter needs a description')
    else:
        if len(description.strip()) > MAX_DESCRIPTION:
            errors.append(f'description is {len(description.strip())} characters; the limit is {MAX_DESCRIPTION}')
        if not re.search(r'\b(use|when|trigger)\b|使用|当|触发|适用', description, re.I):
            warnings.append('description should say WHEN to use the skill (trigger phrases, file types, situations)')
    for key in meta:
        if str(key) not in ALLOWED:
            warnings.append(f'unknown frontmatter key "{key}" (ignored by the Platform)')
    if not (meta.get('version') or (isinstance(meta.get('metadata'), dict) and meta['metadata'].get('version'))):
        warnings.append('add metadata.version (e.g. 1.0.0)')

    count, total = 0, 0
    for current, dirs, files in os.walk(root, followlinks=False):
        for entry in dirs + files:
            full = Path(current) / entry
            if full.is_symlink():
                errors.append(f'symbolic links are not allowed: {full.relative_to(root)}')
        for entry in files:
            full = Path(current) / entry
            if not full.is_symlink():
                count += 1
                total += full.stat().st_size
    if count > MAX_FILES:
        errors.append(f'{count} files; the limit is {MAX_FILES}')
    if total > MAX_UNPACKED:
        errors.append(f'unpacked size {total // 1024 // 1024} MiB exceeds {MAX_UNPACKED // 1024 // 1024} MiB')

    if len(body.splitlines()) > 500:
        warnings.append('SKILL.md body is over 500 lines; move detail into references/')
    for pattern, hint in ((r'\.claude/|\.codex/|\.agents/skills|~/\.', 'refers to another product\'s skill directory; use the `skill` tool'),
                          (r'/workspace/deliverables', 'hard-coded /workspace/deliverables; use the run\'s working directory'),
                          (r'claude -p|claude code|AskUserQuestion', 'depends on a tool this platform does not have')):
        if re.search(pattern, body, re.I):
            warnings.append(f'body {hint}')
    for ref in sorted(set(re.findall(r'`((?:references|scripts|assets|templates)/[\w./-]+)`', body))):
        if not (root / ref.rstrip('.,')).exists():
            warnings.append(f'body mentions `{ref}` but the file does not exist')
    return errors, warnings


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('Usage: validate_skill.py <skill-directory>')
    problems, notes = validate(sys.argv[1])
    for item in problems:
        print('ERROR  ', item)
    for item in notes:
        print('WARNING', item)
    print('Skill is installable.' if not problems else 'Skill would be rejected.')
    sys.exit(1 if problems else 0)
