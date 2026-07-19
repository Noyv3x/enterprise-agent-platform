---
name: "arxiv"
description: "Use when the user wants to find, filter, compare, cite, or read academic papers by topic, author, category, or arXiv ID. Provides no-key API queries, a standard-library helper, citation lookups, and extraction of abstracts or PDFs."
version: "1.0.0"
category: "research"
tags: ["research","arxiv","papers","academic","citations","literature"]
---

# arXiv Research

Use arXiv's public Atom API for discovery and metadata. Use the canonical
abstract page as the primary link. Do not infer that a preprint was
peer-reviewed or accepted unless a reliable source says so.

## Quick actions

Search with a focused network command:

```text
terminal({
  "command":"curl -fsSL --get 'https://export.arxiv.org/api/query' --data-urlencode 'search_query=all:retrieval augmented generation' --data 'max_results=5' --data 'sortBy=relevance' --data 'sortOrder=descending'",
  "timeout_ms":60000
})
```

Read a paper's abstract page or PDF through the managed web tool:

```text
web({
  "action":"extract",
  "arguments":{"urls":["https://arxiv.org/abs/2402.03300"]}
})
```

```text
web({
  "action":"extract",
  "arguments":{"urls":["https://arxiv.org/pdf/2402.03300"],"char_limit":150000}
})
```

PDF extraction can lose equations, figures, tables, and layout. Say when a
claim comes only from extracted text.

## Query syntax

| Prefix | Field | Example |
|---|---|---|
| `all:` | all indexed fields | `all:graph+neural+network` |
| `ti:` | title | `ti:chain+of+thought` |
| `au:` | author | `au:lecun` |
| `abs:` | abstract | `abs:tool+use` |
| `cat:` | category | `cat:cs.AI` |

Combine clauses with `AND`, `OR`, or `ANDNOT`. Prefer URL encoding through
`curl --data-urlencode` or the helper script rather than constructing an
unescaped URL.

Useful parameters:

- `id_list=2402.03300` for one or more comma-separated identifiers;
- `start=0` and `max_results=10` for pagination;
- `sortBy=relevance|lastUpdatedDate|submittedDate`;
- `sortOrder=ascending|descending`.

## Bundled helper script

Supporting files are not executable directly from the read-only Skill package.
To use the helper:

1. Read it:

```text
skill({
  "action":"read",
  "arguments":{"id":"arxiv","file_path":"scripts/search_arxiv.py"}
})
```

2. Copy the returned `content` into the Agent workspace:

```text
write_file({
  "path":".ubitech/tools/search_arxiv.py",
  "content":"<exact content returned by skill read>"
})
```

3. Run the workspace copy:

```text
terminal({
  "command":"python3 .ubitech/tools/search_arxiv.py 'retrieval augmented generation' --max 10 --sort date",
  "timeout_ms":60000
})
```

The script uses only the Python standard library. It supports:

```text
python3 .ubitech/tools/search_arxiv.py "topic words"
python3 .ubitech/tools/search_arxiv.py --author "Author Name" --max 5
python3 .ubitech/tools/search_arxiv.py --category cs.AI --sort date
python3 .ubitech/tools/search_arxiv.py --id 2402.03300
```

## Citation and related-work data

arXiv does not provide citation counts. For an optional secondary signal, use
Semantic Scholar's public Graph API:

```text
terminal({
  "command":"curl -fsSL 'https://api.semanticscholar.org/graph/v1/paper/arXiv:2402.03300?fields=title,authors,year,citationCount,referenceCount,externalIds' | python3 -m json.tool",
  "timeout_ms":60000
})
```

Citation counts change and differ between indexes. Label the provider and
retrieval date. A high count is not proof of correctness.

## Research workflow

1. Form several precise queries using synonyms and field prefixes.
2. Collect title, authors, identifier, date, version, categories, abstract,
   and canonical URL.
3. Remove duplicates by base arXiv identifier.
4. Read the abstract before deciding relevance.
5. Read the full paper when the user's question requires methods or results.
6. Distinguish statements from the paper from your own synthesis.
7. Link every cited paper and never invent missing metadata.

Be considerate of public services: cache results during one task, avoid
parallel request bursts, wait between repeated API calls, and honor HTTP
errors or rate-limit responses.

License and source attribution are in `references/NOTICE.md`.
