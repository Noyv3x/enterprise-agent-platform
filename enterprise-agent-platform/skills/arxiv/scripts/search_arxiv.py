#!/usr/bin/env python3
"""Search the arXiv Atom API and print readable paper metadata.

Needs network access (personal AI sandbox); the chat sandbox has none, use web tools there.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


API_URL = "https://export.arxiv.org/api/query"
USER_AGENT = "agent-platform/1.0"
ATOM = {"a": "http://www.w3.org/2005/Atom"}
OPEN_SEARCH = "http://a9.com/-/spec/opensearch/1.1/"


def text(entry: ET.Element, path: str) -> str:
    node = entry.find(path, ATOM)
    return " ".join((node.text or "").split()) if node is not None else ""


def build_query(
    *,
    query: str | None,
    author: str | None,
    category: str | None,
    identifiers: str | None,
) -> dict[str, str]:
    if identifiers:
        return {"id_list": identifiers}

    clauses: list[str] = []
    if query:
        clauses.append(f"all:{query}")
    if author:
        clauses.append(f"au:{author}")
    if category:
        clauses.append(f"cat:{category}")
    if not clauses:
        raise ValueError("provide a query, --author, --category, or --id")
    return {"search_query": " AND ".join(clauses)}


def fetch(params: dict[str, str], *, timeout: int) -> ET.Element:
    url = f"{API_URL}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/atom+xml",
            "User-Agent": USER_AGENT,
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return ET.fromstring(response.read())


def parse_entries(root: ET.Element) -> list[dict]:
    entries = []
    for entry in root.findall("a:entry", ATOM):
        full_id = text(entry, "a:id").rsplit("/abs/", 1)[-1]
        base_id = re.sub(r"v\d+$", "", full_id)
        entries.append(
            {
                "id": full_id,
                "base_id": base_id,
                "title": text(entry, "a:title"),
                "authors": [text(a, "a:name") for a in entry.findall("a:author", ATOM)],
                "published": text(entry, "a:published")[:10],
                "updated": text(entry, "a:updated")[:10],
                "categories": [n.get("term", "") for n in entry.findall("a:category", ATOM)],
                "abstract": text(entry, "a:summary"),
                # Version-pinned links: a later fetch reads the revision whose metadata was reviewed.
                "url": f"https://arxiv.org/abs/{full_id}",
                "pdf": f"https://arxiv.org/pdf/{full_id}",
                "latest_pdf": f"https://arxiv.org/pdf/{base_id}",
            }
        )
    return entries


def render(root: ET.Element, *, abstract_chars: int, as_json: bool, start: int) -> int:
    entries = parse_entries(root)
    total = root.find(f"{{{OPEN_SEARCH}}}totalResults")
    total_text = total.text.strip() if total is not None and total.text else "unknown"
    if as_json:
        print(json.dumps({"total_results": total_text, "start": start, "entries": entries}, ensure_ascii=False, indent=2))
        return 0
    print(f"Found {total_text} result(s); showing {len(entries)} from offset {start}.\n")
    if not entries:
        print("No results found.")
        return 0

    for index, item in enumerate(entries, start=start + 1):
        abstract = item["abstract"]
        if abstract_chars and len(abstract) > abstract_chars:
            shown = f"{abstract[:abstract_chars]} [TRUNCATED: showing {abstract_chars} of {len(abstract)} characters; use --abstract-chars 0 or fetch the abstract page for the rest]"
        else:
            shown = abstract
        print(f"{index}. {item['title']}")
        print(f"   ID: {item['id']}  (versioned; cite this)")
        print(f"   Authors: {', '.join(item['authors']) or 'Unknown'}")
        print(f"   Published: {item['published'] or 'Unknown'} | Updated: {item['updated'] or 'Unknown'}")
        print(f"   Categories: {', '.join(item['categories']) or 'Unknown'}")
        print(f"   Abstract: {shown}")
        print(f"   URL: {item['url']}")
        print(f"   PDF: {item['pdf']}")
        print()
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("query", nargs="*", help="keywords searched across all fields")
    result.add_argument("--author", help="author name")
    result.add_argument("--category", help="arXiv category such as cs.AI")
    result.add_argument("--id", dest="identifiers", help="one or more comma-separated IDs")
    result.add_argument("--max", dest="max_results", type=int, default=5)
    result.add_argument("--start", type=int, default=0, help="result offset for pagination")
    result.add_argument(
        "--abstract-chars",
        type=int,
        default=500,
        help="abstract characters to print; 0 prints the full abstract (truncation is always marked)",
    )
    result.add_argument("--json", action="store_true", help="print JSON with full abstracts")
    result.add_argument(
        "--sort",
        choices=("relevance", "date", "updated"),
        default="relevance",
    )
    result.add_argument("--timeout", type=int, default=20)
    return result


def main() -> int:
    args = parser().parse_args()
    if not 1 <= args.max_results <= 100:
        print("error: --max must be between 1 and 100", file=sys.stderr)
        return 2
    if args.start < 0 or args.abstract_chars < 0:
        print("error: --start and --abstract-chars must be 0 or greater", file=sys.stderr)
        return 2
    if not 1 <= args.timeout <= 120:
        print("error: --timeout must be between 1 and 120 seconds", file=sys.stderr)
        return 2

    sort_map = {
        "relevance": "relevance",
        "date": "submittedDate",
        "updated": "lastUpdatedDate",
    }
    try:
        params = build_query(
            query=" ".join(args.query).strip() or None,
            author=args.author,
            category=args.category,
            identifiers=args.identifiers,
        )
        params.update(
            {
                "start": str(args.start),
                "max_results": str(args.max_results),
                "sortBy": sort_map[args.sort],
                "sortOrder": "descending",
            }
        )
        return render(
            fetch(params, timeout=args.timeout),
            abstract_chars=args.abstract_chars,
            as_json=args.json,
            start=args.start,
        )
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    except urllib.error.HTTPError as error:
        print(f"arXiv returned HTTP {error.code}: {error.reason}", file=sys.stderr)
    except urllib.error.URLError as error:
        print(f"could not reach arXiv: {error.reason}", file=sys.stderr)
    except ET.ParseError as error:
        print(f"arXiv returned invalid XML: {error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
