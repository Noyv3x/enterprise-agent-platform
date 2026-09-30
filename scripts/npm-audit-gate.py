#!/usr/bin/env python3
"""Fail on high/critical npm advisories except the documented exceptions.

Usage (inside an npm project): npm audit --json | scripts/npm-audit-gate.py audit-exceptions.json
"""
import json
import sys

report = json.load(sys.stdin)
exception = json.load(open(sys.argv[1])) if len(sys.argv) > 1 else None
allowed = set(exception["advisories"]) if exception else set()

failures = []
for name, vuln in report.get("vulnerabilities", {}).items():
    if vuln.get("severity") not in ("high", "critical"):
        continue
    advisories = {v["url"] for v in vuln.get("via", []) if isinstance(v, dict)}
    excepted = (
        exception is not None
        and name == exception["package"]
        and vuln.get("nodes") == [exception["path"]]
        and advisories
        and advisories <= allowed
    )
    # Packages flagged only because they depend on an excepted package.
    only_via_excepted = not advisories and all(
        isinstance(v, str) and v == (exception or {}).get("package") for v in vuln.get("via", [])
    )
    if not (excepted or only_via_excepted):
        failures.append(f"{name} ({vuln.get('severity')}): {sorted(advisories) or vuln.get('via')}")

if failures:
    print("npm audit found unexcepted high/critical advisories:")
    print("\n".join(failures))
    sys.exit(1)
print("npm audit: no unexcepted high/critical advisories")
