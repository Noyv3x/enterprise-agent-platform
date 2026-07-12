"""Hermes plugin exposing ubitech agent knowledge tools."""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from typing import Any


def _platform_url() -> str:
    return (os.getenv("ENTERPRISE_PLATFORM_URL") or "http://127.0.0.1:8765").rstrip("/")


def _agent_token() -> str:
    return os.getenv("ENTERPRISE_AGENT_TOOL_TOKEN", "")


def _get_json(path: str) -> dict[str, Any]:
    req = urllib.request.Request(
        f"{_platform_url()}{path}",
        headers={"X-Enterprise-Agent-Token": _agent_token()},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def enterprise_kb_search(query: str, limit: int = 5) -> str:
    """Search knowledge-base entries by natural-language query."""
    qs = urllib.parse.urlencode({"q": query, "limit": max(1, min(int(limit), 10))})
    return json.dumps(_get_json(f"/api/agent/tools/knowledge/search?{qs}"), ensure_ascii=False)


def enterprise_kb_read(document_id: int) -> str:
    """Read the full content of one knowledge-base document."""
    return json.dumps(_get_json(f"/api/agent/tools/knowledge/documents/{int(document_id)}"), ensure_ascii=False)


def register(ctx):
    ctx.register_tool(
        name="enterprise_kb_search",
        toolset="enterprise_kb",
        schema={
            "type": "function",
            "function": {
                "name": "enterprise_kb_search",
                "description": "Search the knowledge base. Use when the platform suggests kb entries or when shared context may matter.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Natural-language search query."},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 10, "default": 5},
                    },
                    "required": ["query"],
                },
            },
        },
        handler=lambda args: enterprise_kb_search(args.get("query", ""), args.get("limit", 5)),
        requires_env=["ENTERPRISE_PLATFORM_URL", "ENTERPRISE_AGENT_TOOL_TOKEN"],
        description="Search the ubitech agent knowledge base.",
        emoji="📚",
    )
    ctx.register_tool(
        name="enterprise_kb_read",
        toolset="enterprise_kb",
        schema={
            "type": "function",
            "function": {
                "name": "enterprise_kb_read",
                "description": "Read a full knowledge-base document by id.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "document_id": {"type": "integer", "description": "Document id such as the number in kb:123."},
                    },
                    "required": ["document_id"],
                },
            },
        },
        handler=lambda args: enterprise_kb_read(args.get("document_id")),
        requires_env=["ENTERPRISE_PLATFORM_URL", "ENTERPRISE_AGENT_TOOL_TOKEN"],
        description="Read a ubitech agent knowledge-base document.",
        emoji="📖",
    )
