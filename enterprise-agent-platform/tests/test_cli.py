from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class PlatformCLITests(unittest.TestCase):
    def test_migrate_applies_schema_without_starting_the_service(self):
        project = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "enterprise_agent_platform",
                    "migrate",
                    "--data",
                    directory,
                ],
                cwd=project,
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertTrue(payload["ok"])
            database_path = Path(directory) / "platform.db"
            self.assertTrue(database_path.is_file())
            with sqlite3.connect(database_path) as database:
                sandbox_columns = {
                    row[1]
                    for row in database.execute("PRAGMA table_info(agent_scopes)")
                }
                self.assertIn("sandbox_id", sandbox_columns)
                self.assertEqual(
                    database.execute("SELECT COUNT(*) FROM users").fetchone()[0],
                    0,
                )


if __name__ == "__main__":
    unittest.main()
