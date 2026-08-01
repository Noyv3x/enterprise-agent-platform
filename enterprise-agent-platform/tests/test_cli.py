from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from enterprise_agent_platform import __main__ as platform_cli


class PlatformCLITests(unittest.TestCase):
    def setUp(self):
        self._container_env = mock.patch.dict(
            os.environ,
            {"AGENT_PLATFORM_DEPLOYMENT_MODE": "container"},
        )
        self._container_env.start()

    def tearDown(self):
        self._container_env.stop()

    def test_subcommand_is_required(self):
        with mock.patch.object(
            sys,
            "argv",
            ["enterprise-agent-platform"],
        ), mock.patch.object(platform_cli, "run_server") as run_server:
            with self.assertRaises(SystemExit) as raised:
                platform_cli.main()
        self.assertEqual(raised.exception.code, 2)
        run_server.assert_not_called()

    def test_serve_uses_only_current_host_and_port_options(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.object(
                sys,
                "argv",
                [
                    "enterprise-agent-platform",
                    "serve",
                    "--host",
                    "127.0.0.2",
                    "--port",
                    "9876",
                    "--data",
                    directory,
                ],
            ), mock.patch.object(platform_cli, "run_server") as run_server:
                platform_cli.main()

            run_server.assert_called_once()
            config = run_server.call_args.args[0]
            self.assertEqual(config.host, "127.0.0.2")
            self.assertEqual(config.port, 9876)
            self.assertEqual(config.data_dir, Path(directory).resolve())
            self.assertEqual(run_server.call_args.kwargs, {})

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
                tables = {
                    row[0]
                    for row in database.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    )
                }
                self.assertTrue(
                    {
                        "durable_jobs",
                        "agent_run_inputs",
                        "agent_schedules",
                        "agent_schedule_runs",
                    }.issubset(tables)
                )
                indexes = {
                    row[0]
                    for row in database.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'index'"
                    )
                }
                self.assertIn("idx_agent_schedule_runs_job", indexes)


if __name__ == "__main__":
    unittest.main()
