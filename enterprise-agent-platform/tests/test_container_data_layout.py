from __future__ import annotations

import re
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


class ContainerDataLayoutTests(unittest.TestCase):
    def test_firecrawl_uses_only_the_postgresql_baseline_data_roots(self) -> None:
        compose = (REPOSITORY_ROOT / "containers" / "compose.yaml").read_text(
            encoding="utf-8"
        )

        self.assertNotIn("foundationdb", compose.lower())
        self.assertNotIn("/var/fdb", compose.lower())
        self.assertIn('NUQ_BACKEND: "pg"', compose)

        mounts = set(
            re.findall(
                r"\$\{UBITECH_DATA_ROOT\}/data/runtimes/firecrawl/([^:\s]+):([^:\s]+)",
                compose,
            )
        )
        self.assertEqual(
            mounts,
            {
                ("postgres", "/var/lib/postgresql/data"),
                ("rabbitmq", "/var/lib/rabbitmq"),
                ("redis", "/data"),
            },
        )


if __name__ == "__main__":
    unittest.main()
