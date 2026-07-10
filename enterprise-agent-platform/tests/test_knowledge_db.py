from __future__ import annotations

import os
import tempfile
import threading
import unittest
from pathlib import Path

from enterprise_agent_platform import knowledge as knowledge_module
from enterprise_agent_platform.db import Database
from enterprise_agent_platform.knowledge import KnowledgeBase


class KnowledgeSearchEscapingTests(unittest.TestCase):
    """LIKE/FTS fallback wildcard escaping in KnowledgeBase.search."""

    def test_percent_query_does_not_act_as_wildcard(self):
        # A bare '%' produces an empty FTS query (make_fts_query strips
        # non-word chars), so search falls through to the LIKE path. With
        # proper ESCAPE handling, '%' is matched literally and only the
        # document that actually contains a '%' is returned -- the old
        # unescaped code would have matched every document.
        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "kb.db")
            try:
                kb = KnowledgeBase(db)
                with_pct = kb.add_document(
                    title="Discount", content="Apply a 50% off promo code now"
                )
                kb.add_document(title="Cats", content="Nothing special about cats")
                kb.add_document(title="Dogs", content="Nothing special about dogs")

                hits = kb.search("%")
                self.assertEqual([h.id for h in hits], [with_pct["id"]])
            finally:
                db.close()

    def test_underscore_query_does_not_act_as_wildcard(self):
        # '_' is a single-character LIKE wildcard; escaped it must match only
        # documents containing a literal underscore, not every document.
        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "kb.db")
            try:
                kb = KnowledgeBase(db)
                kb.add_document(title="Alpha", content="plain text without specials")
                with_underscore = kb.add_document(
                    title="Snippet", content="variable my_value is set here"
                )
                kb.add_document(title="Beta", content="more plain prose")

                hits = kb.search("_")
                self.assertEqual([h.id for h in hits], [with_underscore["id"]])
            finally:
                db.close()

    def test_like_fallback_escapes_metacharacters(self):
        # Exercise the LIKE fallback directly (FTS disabled) and confirm a
        # query consisting only of wildcard metacharacters matches nothing
        # when no document contains those literal characters.
        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "kb.db")
            try:
                db.fts_available = False  # force the LIKE fallback path
                kb = KnowledgeBase(db)
                kb.add_document(title="One", content="content one")
                kb.add_document(title="Two", content="content two")

                # No document contains a literal '%', so escaped search yields
                # nothing instead of the unescaped wildcard matching everything.
                self.assertEqual(kb.search("%"), [])
                # And a real term still resolves through the same fallback.
                self.assertEqual([h.title for h in kb.search("one")], ["One"])
            finally:
                db.close()


class KnowledgeDedupTests(unittest.TestCase):
    def test_identical_document_is_deduped(self):
        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "kb.db")
            try:
                kb = KnowledgeBase(db)
                first = kb.add_document(
                    title="Runbook", content="Restart service alpha.", source="wiki"
                )
                second = kb.add_document(
                    title="Runbook", content="Restart service alpha.", source="wiki"
                )

                self.assertEqual(first["id"], second["id"])
                count = db.scalar("SELECT count(*) FROM knowledge_documents")
                self.assertEqual(count, 1)
            finally:
                db.close()

    def test_differing_source_creates_new_row(self):
        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "kb.db")
            try:
                kb = KnowledgeBase(db)
                first = kb.add_document(
                    title="Runbook", content="Restart service alpha.", source="wiki"
                )
                second = kb.add_document(
                    title="Runbook", content="Restart service alpha.", source="confluence"
                )

                self.assertNotEqual(first["id"], second["id"])
                count = db.scalar("SELECT count(*) FROM knowledge_documents")
                self.assertEqual(count, 2)
            finally:
                db.close()

    def test_concurrent_identical_insert_is_idempotent(self):
        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "kb.db")
            try:
                kb = KnowledgeBase(db)
                barrier = threading.Barrier(2)
                results: list[tuple[int, bool]] = []
                errors: list[BaseException] = []

                def insert() -> None:
                    try:
                        barrier.wait()
                        document, created = kb.add_document_with_status(
                            title="Concurrent",
                            content="one canonical document",
                            source="sync",
                        )
                        results.append((int(document["id"]), created))
                    except BaseException as exc:  # pragma: no cover - asserted below
                        errors.append(exc)

                threads = [threading.Thread(target=insert) for _ in range(2)]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join(5)

                self.assertEqual(errors, [])
                self.assertEqual(len(results), 2)
                self.assertEqual({item[0] for item in results}, {results[0][0]})
                self.assertEqual(sum(1 for _doc_id, created in results if created), 1)
                self.assertEqual(db.scalar("SELECT count(*) FROM knowledge_documents"), 1)
            finally:
                db.close()

    def test_hash_migration_preserves_historical_duplicate_ids(self):
        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "kb.db")
            try:
                ts = 1
                for _ in range(2):
                    db.insert(
                        """
                        INSERT INTO knowledge_documents(
                            title, summary, content, source, created_by, created_at, updated_at
                        ) VALUES ('Legacy', 'summary', 'same body', 'sync', NULL, ?, ?)
                        """,
                        (ts, ts),
                    )
                ids_before = [row["id"] for row in db.query("SELECT id FROM knowledge_documents ORDER BY id")]

                kb = KnowledgeBase(db)
                ids_after = [row["id"] for row in db.query("SELECT id FROM knowledge_documents ORDER BY id")]
                document, created = kb.add_document_with_status(
                    title="Legacy", content="same body", source="sync"
                )

                self.assertEqual(ids_after, ids_before)
                self.assertFalse(created)
                self.assertEqual(document["id"], ids_before[0])
            finally:
                db.close()


class KnowledgeContentCapTests(unittest.TestCase):
    def test_content_exceeding_cap_raises(self):
        # MAX_CONTENT_CHARS is resolved at import time, so patch the module
        # global to a small value and restore it afterwards.
        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "kb.db")
            original = knowledge_module.MAX_CONTENT_CHARS
            knowledge_module.MAX_CONTENT_CHARS = 16
            try:
                kb = KnowledgeBase(db)
                with self.assertRaises(ValueError):
                    kb.add_document(title="Oversize", content="x" * 100)
                # Nothing was inserted when the cap is exceeded.
                self.assertEqual(db.scalar("SELECT count(*) FROM knowledge_documents"), 0)
                # A document within the cap is still accepted.
                doc = kb.add_document(title="Tiny", content="short")
                self.assertEqual(doc["title"], "Tiny")
            finally:
                knowledge_module.MAX_CONTENT_CHARS = original
                db.close()

    def test_cap_resolver_reads_env_and_defaults(self):
        previous = os.environ.get("ENTERPRISE_KB_MAX_CONTENT_CHARS")
        try:
            os.environ["ENTERPRISE_KB_MAX_CONTENT_CHARS"] = "42"
            self.assertEqual(knowledge_module._resolve_max_content_chars(), 42)
            # 0 disables the limit.
            os.environ["ENTERPRISE_KB_MAX_CONTENT_CHARS"] = "0"
            self.assertEqual(knowledge_module._resolve_max_content_chars(), 0)
            # Garbage falls back to the generous default rather than crashing.
            os.environ["ENTERPRISE_KB_MAX_CONTENT_CHARS"] = "not-an-int"
            self.assertEqual(knowledge_module._resolve_max_content_chars(), 2_000_000)
        finally:
            if previous is None:
                os.environ.pop("ENTERPRISE_KB_MAX_CONTENT_CHARS", None)
            else:
                os.environ["ENTERPRISE_KB_MAX_CONTENT_CHARS"] = previous


class DatabaseFtsRebuildTests(unittest.TestCase):
    def _docsize_count(self, db: Database) -> int:
        return db._conn.execute(
            "SELECT count(*) FROM knowledge_fts_docsize"
        ).fetchone()[0]

    def test_init_schema_rebuilds_stale_fts_index(self):
        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "kb.db")
            try:
                if not db.fts_available:
                    self.skipTest("FTS5 not available in this SQLite build")
                kb = KnowledgeBase(db)
                doc = kb.add_document(title="RebuildMe", content="alpha bravo charlie")

                # Simulate a divergence between source rows and the index (as
                # happens when documents predate FTS5 availability): empty the
                # index without touching the source table.
                db._conn.execute(
                    "INSERT INTO knowledge_fts(knowledge_fts) VALUES('delete-all')"
                )
                db._conn.commit()
                self.assertEqual(self._docsize_count(db), 0)
                self.assertEqual(kb.search("bravo"), [])

                # Re-running init_schema must detect the stale index and rebuild.
                db.init_schema()
                self.assertEqual(self._docsize_count(db), 1)
                self.assertEqual([h.id for h in kb.search("bravo")], [doc["id"]])
            finally:
                db.close()

    def test_fresh_database_instance_rebuilds_preexisting_doc(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "kb.db"
            db = Database(path)
            try:
                if not db.fts_available:
                    self.skipTest("FTS5 not available in this SQLite build")
                kb = KnowledgeBase(db)
                kb.add_document(title="Persisted", content="delta echo foxtrot")
                db._conn.execute(
                    "INSERT INTO knowledge_fts(knowledge_fts) VALUES('delete-all')"
                )
                db._conn.commit()
            finally:
                db.close()

            # A brand-new Database on the same file runs init_schema in its
            # constructor, which should rebuild the index so the pre-existing
            # document is findable again.
            db2 = Database(path)
            try:
                kb2 = KnowledgeBase(db2)
                self.assertEqual(self._docsize_count(db2), 1)
                self.assertEqual([h.title for h in kb2.search("echo")], ["Persisted"])
            finally:
                db2.close()

    def test_fts_index_is_stale_detection(self):
        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "kb.db")
            try:
                if not db.fts_available:
                    self.skipTest("FTS5 not available in this SQLite build")
                kb = KnowledgeBase(db)
                kb.add_document(title="A", content="indexed body one")
                kb.add_document(title="B", content="indexed body two")

                # In sync: docsize == doc_count -> not stale.
                self.assertFalse(db._fts_index_is_stale(2))
                # Pretend there are more source rows than indexed -> stale.
                self.assertTrue(db._fts_index_is_stale(5))
            finally:
                db.close()


class DatabaseTransactionTests(unittest.TestCase):
    def _count(self, db: Database) -> int:
        return db.scalar("SELECT count(*) FROM knowledge_documents")

    def test_transaction_rolls_back_on_exception(self):
        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "kb.db")
            try:
                with self.assertRaises(RuntimeError):
                    with db.transaction() as conn:
                        conn.execute(
                            "INSERT INTO knowledge_documents"
                            "(title, summary, content, source, created_at, updated_at)"
                            " VALUES (?, ?, ?, ?, ?, ?)",
                            ("First", "", "body", "", 1, 1),
                        )
                        conn.execute(
                            "INSERT INTO knowledge_documents"
                            "(title, summary, content, source, created_at, updated_at)"
                            " VALUES (?, ?, ?, ?, ?, ?)",
                            ("Second", "", "body", "", 1, 1),
                        )
                        raise RuntimeError("boom")

                # Neither row from the aborted transaction is persisted.
                self.assertEqual(self._count(db), 0)
                self.assertIsNone(
                    db.query_one(
                        "SELECT id FROM knowledge_documents WHERE title = ?", ("First",)
                    )
                )
            finally:
                db.close()

    def test_transaction_commits_on_success(self):
        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "kb.db")
            try:
                with db.transaction() as conn:
                    conn.execute(
                        "INSERT INTO knowledge_documents"
                        "(title, summary, content, source, created_at, updated_at)"
                        " VALUES (?, ?, ?, ?, ?, ?)",
                        ("Committed", "", "body", "", 1, 1),
                    )
                    conn.execute(
                        "INSERT INTO knowledge_documents"
                        "(title, summary, content, source, created_at, updated_at)"
                        " VALUES (?, ?, ?, ?, ?, ?)",
                        ("AlsoCommitted", "", "body", "", 1, 1),
                    )

                self.assertEqual(self._count(db), 2)
                titles = {
                    row["title"]
                    for row in db.query("SELECT title FROM knowledge_documents")
                }
                self.assertEqual(titles, {"Committed", "AlsoCommitted"})
            finally:
                db.close()


if __name__ == "__main__":
    unittest.main()
