from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from enterprise_agent_platform.db import Database
from enterprise_agent_platform.sylver_platform_connections import (
    SylverPlatformConnectionError,
    SylverPlatformConnectionStore,
)


TOKEN = "sylver-personal-token-not-for-output"


def connection_body(**overrides):
    return {
        "base_url": "https://devops.example.test",
        "token": TOKEN,
        "remote_user_id": 13,
        "username": "operator",
        "full_name": "Platform Operator",
        "title": "Engineer",
        "email": "operator@example.test",
        "role": "member",
        **overrides,
    }


class SylverPlatformConnectionStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.temporary_directory.name) / "platform.db")
        self.db.executemany(
            """
            INSERT INTO users(
                id, username, display_name, password_hash, role,
                permission_group, created_at
            ) VALUES (?, ?, ?, 'hash', 'member', 'member', 1)
            """,
            (
                (1, "one", "One"),
                (2, "two", "Two"),
            ),
        )
        self.store = SylverPlatformConnectionStore(self.db)

    def tearDown(self) -> None:
        if self.db is not None:
            self.db.close()
        self.temporary_directory.cleanup()

    def test_upsert_exposes_only_the_public_credential_projection(self):
        stored = self.store.upsert(1, connection_body())

        self.assertEqual(stored["owner_user_id"], 1)
        self.assertEqual(stored["remote_user_id"], 13)
        self.assertEqual(stored["username"], "operator")
        self.assertTrue(stored["credential_configured"])
        self.assertNotIn("token", stored)
        self.assertNotIn(TOKEN, repr(stored))
        self.assertEqual(self.store.get(1), stored)

        internal = self.store.get_with_credential(1)
        self.assertIsNotNone(internal)
        connection, token = internal or ({}, "")
        self.assertEqual(connection, stored)
        self.assertEqual(token, TOKEN)
        self.assertNotIn("token", connection)

    def test_upsert_atomically_replaces_identity_and_credential(self):
        with mock.patch(
            "enterprise_agent_platform.sylver_platform_connections.now_ts",
            side_effect=(100, 200),
        ):
            first = self.store.upsert(1, connection_body())
            updated = self.store.upsert(
                1,
                connection_body(
                    token="replacement-token",
                    remote_user_id=14,
                    username="renamed",
                    full_name="Renamed User",
                ),
            )

        self.assertEqual(first["created_at"], 100)
        self.assertEqual(updated["created_at"], 100)
        self.assertEqual(updated["verified_at"], 200)
        self.assertEqual(updated["updated_at"], 200)
        self.assertEqual(updated["remote_user_id"], 14)
        self.assertEqual(updated["username"], "renamed")
        self.assertEqual(
            (self.store.get_with_credential(1) or ({}, ""))[1],
            "replacement-token",
        )

    def test_duplicate_remote_identity_rolls_back_without_partial_credential(self):
        self.store.upsert(1, connection_body())

        with self.assertRaisesRegex(
            SylverPlatformConnectionError,
            "already connected to another user",
        ):
            self.store.upsert(2, connection_body(token="must-not-persist"))

        self.assertIsNone(self.store.get(2))
        self.assertEqual(
            self.db.scalar(
                "SELECT count(*) FROM sylver_platform_credentials "
                "WHERE owner_user_id = 2"
            ),
            0,
        )

    def test_delete_cascades_the_private_credential(self):
        self.store.upsert(1, connection_body())

        self.assertTrue(self.store.delete(1))
        self.assertFalse(self.store.delete(1))
        self.assertIsNone(self.store.get(1))
        self.assertEqual(
            self.db.scalar(
                "SELECT count(*) FROM sylver_platform_credentials "
                "WHERE owner_user_id = 1"
            ),
            0,
        )

    def test_user_deletion_cascades_connection_and_credential(self):
        self.store.upsert(1, connection_body())

        self.db.execute("DELETE FROM users WHERE id = 1")

        self.assertIsNone(self.store.get(1))
        self.assertEqual(
            self.db.scalar("SELECT count(*) FROM sylver_platform_credentials"), 0
        )

    def test_invalid_and_unknown_fields_are_rejected(self):
        invalid_bodies = (
            connection_body(remote_user_id=0),
            connection_body(username=""),
            connection_body(token=""),
            connection_body(unexpected=True),
        )
        for body in invalid_bodies:
            with self.subTest(body=body):
                with self.assertRaises(SylverPlatformConnectionError):
                    self.store.upsert(1, body)
        self.assertIsNone(self.store.get(1))

    def test_baseline_rejects_connection_table_without_identity_unique(self):
        path = self.db.path
        self.db.close()
        self.db = None
        with sqlite3.connect(path) as connection:
            connection.execute("PRAGMA foreign_keys=OFF")
            connection.execute("DROP TABLE sylver_platform_credentials")
            connection.execute("DROP TABLE sylver_platform_connections")
            connection.execute(
                """
                CREATE TABLE sylver_platform_connections (
                    owner_user_id INTEGER PRIMARY KEY
                        REFERENCES users(id) ON DELETE CASCADE,
                    base_url TEXT NOT NULL CHECK(length(base_url) > 0),
                    remote_user_id INTEGER NOT NULL CHECK(remote_user_id > 0),
                    username TEXT NOT NULL CHECK(length(username) > 0),
                    full_name TEXT NOT NULL DEFAULT '',
                    title TEXT NOT NULL DEFAULT '',
                    email TEXT NOT NULL DEFAULT '',
                    role TEXT NOT NULL DEFAULT '',
                    verified_at INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE sylver_platform_credentials (
                    owner_user_id INTEGER PRIMARY KEY
                        REFERENCES sylver_platform_connections(owner_user_id)
                        ON DELETE CASCADE,
                    token TEXT NOT NULL CHECK(length(token) > 0),
                    updated_at INTEGER NOT NULL
                )
                """
            )

        with self.assertRaisesRegex(
            sqlite3.DatabaseError,
            "missing current unique constraint",
        ):
            Database(path)


if __name__ == "__main__":
    unittest.main()
