from __future__ import annotations

import re
import stat
from pathlib import Path


MAX_UPSTREAM_COMPOSE_BYTES = 2 * 1024 * 1024


class UpstreamSourceValidationError(RuntimeError):
    pass


def parse_compose_service_names(path: Path) -> tuple[str, ...]:
    """Parse a narrow, unambiguous top-level Compose service inventory.

    The managed Firecrawl contract owns one known upstream YAML shape. A
    broader or ambiguous shape fails closed instead of silently launching a
    service that lacks a platform-pinned image override.
    """

    try:
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise UpstreamSourceValidationError(
                "managed Firecrawl Compose file must be a regular file"
            )
        if metadata.st_size > MAX_UPSTREAM_COMPOSE_BYTES:
            raise UpstreamSourceValidationError(
                "managed Firecrawl Compose file is too large"
            )
        text = path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError, UnicodeError) as exc:
        raise UpstreamSourceValidationError(
            f"managed Firecrawl Compose file cannot be read: {path}"
        ) from exc

    in_services = False
    found_services = False
    names: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        prefix = line[: len(line) - len(line.lstrip())]
        if "\t" in prefix:
            raise UpstreamSourceValidationError(
                "managed Firecrawl Compose services use unsupported indentation"
            )
        indent = len(prefix)
        if not in_services:
            if indent == 0 and re.fullmatch(r"services:\s*(?:#.*)?", line):
                in_services = True
                found_services = True
            continue
        if indent == 0:
            break
        if indent == 2:
            match = re.fullmatch(
                r"  ([A-Za-z0-9][A-Za-z0-9._-]*):\s*(?:#.*)?",
                line,
            )
            if match is None:
                raise UpstreamSourceValidationError(
                    "managed Firecrawl Compose service inventory cannot be parsed safely"
                )
            name = match.group(1)
            if name in names:
                raise UpstreamSourceValidationError(
                    f"managed Firecrawl Compose contains duplicate service: {name}"
                )
            names.append(name)
        elif indent < 2:
            raise UpstreamSourceValidationError(
                "managed Firecrawl Compose service inventory cannot be parsed safely"
            )
    if not found_services or not names:
        raise UpstreamSourceValidationError(
            "managed Firecrawl Compose contains no services"
        )
    return tuple(sorted(names))
