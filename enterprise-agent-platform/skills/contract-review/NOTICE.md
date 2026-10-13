# Notice

- Origin: https://github.com/anthropics/knowledge-work-plugins (`legal/`: skills `review-contract`, `triage-nda`, `legal-risk-assessment`, `compliance-check`)
- Upstream revision: `02ffa99ff00ce4d3046ccebabb8357cb39f3ab06` (main, committed 2026-10-11; cloned 2026-10-13)
- License: Apache-2.0. `legal/LICENSE` in the upstream tree (the standard Apache-2.0 text, verified; the repository-root LICENSE additionally carries unrelated trailing text, which is not reproduced) is kept verbatim as `LICENSE`.

## Changes made for this platform
- Merged and condensed `review-contract`, `triage-nda` (screen) and `legal-risk-assessment` (severity × likelihood matrix, green/yellow/red classification, redline format) into one skill.
- Jurisdiction made explicit: upstream's default positions are US-based; this version states the governing law first, defaults to PRC (mainland) business context, and refuses silent application of foreign positions.
- Added a PRC-oriented clause checklist (signing formalities, invoices/tax, liquidated damages, personal information and cross-border data, arbitration clause validity, etc.) marked as leads that must be verified against current official text with the platform web tools.
- Added an attorney-review boundary, scope limits (no signing/sending/court documents), Chinese output template, and artifact/Markdown/DOCX delivery per platform rules.
- Removed: slash-command invocation, `legal.local.md` playbook files, MCP connector (CLM/Slack) steps and routing, and the other legal skills (brief, legal-response, meeting-briefing, signature-request, vendor-check, compliance-check).
