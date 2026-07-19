#!/usr/bin/env python3
"""Search the arXiv Atom API and print readable paper metadata."""

from __future__ import annotations

import argparse
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


API_URL = "https://export.arxiv.org/api/query"
USER_AGENT = "ubitech-agent/1.0"
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


def render(root: ET.Element) -> int:
    entries = root.findall("a:entry", ATOM)
    total = root.find(f"{{{OPEN_SEARCH}}}totalResults")
    if total is not None and total.text:
        print(f"Found {total.text.strip()} result(s); showing {len(entries)}.\n")
    if not entries:
        print("No results found.")
        return 0

    for index, entry in enumerate(entries, start=1):
        raw_id = text(entry, "a:id")
        full_id = raw_id.rsplit("/abs/", 1)[-1]
        base_id = re.sub(r"v\d+$", "", full_id)
        authors = ", ".join(
            text(author, "a:name") for author in entry.findall("a:author", ATOM)
        )
        categories = ", ".join(
            node.get("term", "") for node in entry.findall("a:category", ATOM)
        )
        summary = text(entry, "a:summary")
        published = text(entry, "a:published")[:10]
        updated = text(entry, "a:updated")[:10]

        print(f"{index}. {text(entry, 'a:title')}")
        print(f"   ID: {full_id}")
        print(f"   Authors: {authors or 'Unknown'}")
        print(f"   Published: {published or 'Unknown'} | Updated: {updated or 'Unknown'}")
        print(f"   Categories: {categories or 'Unknown'}")
        print(f"   Abstract: {summary[:500]}{'...' if len(summary) > 500 else ''}")
        print(f"   URL: https://arxiv.org/abs/{base_id}")
        print(f"   PDF: https://arxiv.org/pdf/{base_id}")
        print()
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("query", nargs="*", help="keywords searched across all fields")
    result.add_argument("--author", help="author name")
    result.add_argument("--category", help="arXiv category such as cs.AI")
    result.add_argument("--id", dest="identifiers", help="one or more comma-separated IDs")
    result.add_argument("--max", dest="max_results", type=int, default=5)
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
                "max_results": str(args.max_results),
                "sortBy": sort_map[args.sort],
                "sortOrder": "descending",
            }
        )
        return render(fetch(params, timeout=args.timeout))
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
