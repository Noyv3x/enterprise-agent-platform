# Attribution and licence

The "render pages to images and look at them" verification workflow and the
quality expectations (consistent typography, no clipped text or unreadable
glyphs, ASCII hyphens, readable citations) in `SKILL.md` are adapted from the
`pdf` skill of OpenAI's skills repository.

- Origin: https://github.com/openai/skills, `skills/.curated/pdf/SKILL.md`
- Revision: 49f948faa9258a0c61caceaf225e179651397431
- Licence: Apache License 2.0, full text in `LICENSE-openai-pdf.txt`
- Changes: rewritten for this platform. Poppler `pdftoppm` replaced by `pypdfium2`
  (installed in the sandbox image); added an embedded-CJK-font strategy, the bundled
  ReportLab kit and scripts, pypdf recipes and platform delivery conventions
  (MEDIA/artifact). The helper scripts and the other skills are original to this
  repository.

No part of Anthropic's source-available docx/pdf/pptx/xlsx skills was used.

Third-party runtime components (not bundled in this directory): ReportLab (BSD),
pypdf (BSD-3-Clause), pypdfium2 (Apache-2.0 / BSD-3-Clause; PDFium BSD-3-Clause),
WenQuanYi Micro Hei font (Apache-2.0 or GPL-3.0 with font exception).
