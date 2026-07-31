from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import tempfile
import unittest
from unittest import mock
from pathlib import Path

from enterprise_agent_platform import handoff_evidence
from enterprise_agent_platform.camofox_state import ensure_camofox_runtime_sidecar
from enterprise_agent_platform.container_contract_generated import AGENT_RUNTIME_HANDOFF
from enterprise_agent_platform.db import Database
from enterprise_agent_platform.handoff_evidence import (
    _runtime_directory_names,
    _runtime_hash_regular_at,
    _runtime_identity,
    _runtime_jsonl,
    collect_platform_handoff_evidence,
)
from enterprise_agent_platform.secure_fs import (
    ensure_private_directory,
    open_private_directory_fd,
)


class PlatformHandoffEvidenceTests(unittest.TestCase):
    def test_runtime_identity_queries_stop_at_the_generated_record_budget(self):
        class RecordingDatabase:
            def __init__(self):
                self.calls: list[tuple[str, tuple[int, ...]]] = []

            def query(self, sql, params=()):
                self.calls.append((sql, tuple(params)))
                return []

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime = self._runtime_root(root)
            database = RecordingDatabase()
            with mock.patch.object(handoff_evidence, "_MAX_RUNTIME_IDENTITIES", 2):
                _runtime_identity(database, runtime)
            self.assertEqual(len(database.calls), 3)
            for sql, params in database.calls:
                self.assertIn("LIMIT ?", sql)
                self.assertEqual(params, (3,))

            class OverflowDatabase(RecordingDatabase):
                def query(self, sql, params=()):
                    super().query(sql, params)
                    return [{"scope_key": str(index)} for index in range(3)]

            overflow = OverflowDatabase()
            with mock.patch.object(handoff_evidence, "_MAX_RUNTIME_IDENTITIES", 2):
                with self.assertRaisesRegex(sqlite3.DatabaseError, "count exceeds"):
                    _runtime_identity(overflow, runtime)
            self.assertEqual(len(overflow.calls), 1)

    def test_empty_current_runtime_produces_bounded_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            db = Database(root / "platform.db")
            try:
                ensure_camofox_runtime_sidecar(root)
                self._runtime_root(root)
                with mock.patch.object(
                    db, "query", wraps=db.query
                ) as materializing_queries, mock.patch.object(
                    db, "query_one", wraps=db.query_one
                ) as singleton_queries:
                    value = collect_platform_handoff_evidence(
                        db,
                        root,
                        hashlib.sha256(b"workspaces").hexdigest(),
                        self._idle_blockers(),
                    )
                self.assertEqual(value["schema_version"], 1)
                self.assertEqual(value["database_integrity"], "ok")
                self.assertRegex(value["runtime_identity_sha256"], r"^[0-9a-f]{64}$")
                self.assertFalse(
                    any(
                        "foreign_key_check" in call.args[0]
                        for call in materializing_queries.call_args_list
                    )
                )
                self.assertTrue(
                    any(
                        "foreign_key_check" in call.args[0]
                        for call in singleton_queries.call_args_list
                    )
                )
            finally:
                db.close()

    def test_active_runtime_idempotency_record_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            db = Database(root / "platform.db")
            try:
                ensure_camofox_runtime_sidecar(root)
                self._runtime_root(root)
                directory = ensure_private_directory(root / "runtimes" / "agent" / "idempotency")
                path = directory / "index.json"
                path.write_text(
                    json.dumps(
                        {
                            "version": 1,
                            "records": [
                                {
                                    "lookup_hash": "a" * 64,
                                    "run_id": "run_active",
                                    "session_id": "session_active",
                                    "status": "running",
                                }
                            ],
                        }
                    ),
                    encoding="utf-8",
                )
                path.chmod(0o600)
                with self.assertRaisesRegex(Exception, "idempotency record"):
                    collect_platform_handoff_evidence(
                        db,
                        root,
                        hashlib.sha256(b"workspaces").hexdigest(),
                        self._idle_blockers(),
                    )
            finally:
                db.close()

    def test_runtime_machine_versions_require_json_integers(self):
        for directory_name, file_name, payload in (
            ("approvals", "always.json", {"version": True, "grants": []}),
            ("approvals", "always.json", {"version": 2.0, "grants": []}),
            ("idempotency", "index.json", {"version": True, "records": []}),
            ("idempotency", "index.json", {"version": 1.0, "records": []}),
        ):
            with self.subTest(directory=directory_name, payload=payload):
                with tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary)
                    db = Database(root / "platform.db")
                    try:
                        ensure_camofox_runtime_sidecar(root)
                        runtime = self._runtime_root(root)
                        directory = ensure_private_directory(runtime / directory_name)
                        path = directory / file_name
                        path.write_text(json.dumps(payload) + "\n", encoding="utf-8")
                        path.chmod(0o600)
                        with self.assertRaisesRegex(
                            sqlite3.DatabaseError, "outside schema|invalid"
                        ):
                            collect_platform_handoff_evidence(
                                db,
                                root,
                                hashlib.sha256(b"workspaces").hexdigest(),
                                self._idle_blockers(),
                            )
                    finally:
                        db.close()

    def test_jsonl_uses_generated_limit_and_ignores_whitespace_only_lines(self):
        self.assertEqual(
            handoff_evidence._MAX_RUNTIME_JSONL_RECORDS,
            AGENT_RUNTIME_HANDOFF["validation_limits"]["maximum_jsonl_records"],
        )
        raw = b' \t\r\n{"id":"one"}\n\n  \t\n{"id":"two"}\n'
        with mock.patch.object(
            handoff_evidence,
            "_MAX_RUNTIME_JSONL_RECORDS",
            2,
        ):
            self.assertEqual(
                [record["id"] for record in _runtime_jsonl(raw, "test")],
                ["one", "two"],
            )
            with self.assertRaisesRegex(sqlite3.DatabaseError, "record limit"):
                list(_runtime_jsonl(raw + b'{"id":"three"}\n', "test"))
        with self.assertRaisesRegex(sqlite3.DatabaseError, "invalid JSON"):
            list(_runtime_jsonl(b'{"payload":NaN}\n', "test"))

    def test_directory_enumeration_stops_at_the_generated_entry_budget(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            root.chmod(0o700)
            for name in ("one", "two", "three"):
                (root / name).write_bytes(b"")
            directory_fd = open_private_directory_fd(root)
            try:
                with self.assertRaisesRegex(sqlite3.DatabaseError, "entry limit"):
                    _runtime_directory_names(directory_fd, maximum_entries=2)
            finally:
                os.close(directory_fd)

    def test_retired_regular_file_is_rejected_by_stat_before_reading(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            root.chmod(0o700)
            path = root / "oversized"
            path.write_bytes(b"four")
            path.chmod(0o600)
            directory_fd = open_private_directory_fd(root)
            try:
                before = path.stat()
                with mock.patch.object(
                    handoff_evidence.os,
                    "open",
                    side_effect=AssertionError("oversized file must not be opened"),
                ):
                    with self.assertRaisesRegex(
                        sqlite3.DatabaseError, "byte budget"
                    ):
                        _runtime_hash_regular_at(
                            directory_fd,
                            path.name,
                            before,
                            before.st_dev,
                            maximum_bytes=3,
                        )
            finally:
                os.close(directory_fd)

    @staticmethod
    def _idle_blockers() -> dict[str, int | bool]:
        return {
            "reserved": False,
            "active_agent_tasks": 0,
            "active_learning_reviews": 0,
            "queued_agent_jobs": 0,
            "running_agent_jobs": 0,
            "admissions_in_progress": 0,
        }

    @staticmethod
    def _runtime_root(root: Path) -> Path:
        ensure_private_directory(root / "runtimes")
        return ensure_private_directory(root / "runtimes" / "agent")


if __name__ == "__main__":
    unittest.main()
