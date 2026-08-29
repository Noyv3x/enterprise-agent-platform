from __future__ import annotations

import json
import os
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path

from enterprise_agent_platform import knowledge as knowledge_module
from enterprise_agent_platform.db import Database
from enterprise_agent_platform.jobs import DurableJobStore
from enterprise_agent_platform.knowledge import (
    EmbeddingResponseError,
    KnowledgeBase,
    KnowledgeDisabledError,
    KnowledgeEmbeddingConfig,
    KNOWLEDGE_INDEX_JOB_KIND,
    OpenAIEmbeddingClient,
    chunk_document,
)


class FakeEmbeddingClient:
    def __init__(self):
        self.calls: list[list[str]] = []

    def embed(self, texts):
        values = [str(text) for text in texts]
        self.calls.append(values)
        result = []
        for text in values:
            lowered = text.casefold()
            result.append([
                1.0 if "alpha" in lowered else 0.1,
                1.0 if "beta" in lowered else 0.1,
                1.0 if "gamma" in lowered else 0.1,
            ])
        return result


def configured_knowledge(db: Database, client=None) -> KnowledgeBase:
    return KnowledgeBase(
        db,
        KnowledgeEmbeddingConfig(
            base_url="https://embeddings.example/v1",
            model="multilingual-test",
            api_key="test-secret",
            batch_size=2,
        ),
        client or FakeEmbeddingClient(),
    )


def queued_index_payloads(
    db: Database,
    generation_id: int | None = None,
) -> list[dict]:
    return [
        job.payload
        for job in DurableJobStore(db).queued(KNOWLEDGE_INDEX_JOB_KIND, limit=None)
        if generation_id is None
        or int(job.payload.get("generation_id") or 0) == generation_id
    ]


class KnowledgeConfigurationTests(unittest.TestCase):
    def test_missing_key_disables_mutation_and_search_but_preserves_source_reads(self):
        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "kb.db")
            try:
                db.execute(
                    "INSERT INTO knowledge_documents("
                    "title, summary, content, source, created_at, updated_at, content_hash"
                    ") VALUES (?, '', ?, '', 1, 1, ?)",
                    ("Existing", "preserved source", "a" * 64),
                )
                knowledge = KnowledgeBase(db)

                self.assertEqual(knowledge.status()["state"], "disabled")
                self.assertEqual(knowledge.list_documents()[0]["title"], "Existing")
                self.assertEqual(knowledge.get_document(1)["content"], "preserved source")
                with self.assertRaises(KnowledgeDisabledError):
                    knowledge.add_document_with_status(title="New", content="body")
                with self.assertRaises(KnowledgeDisabledError):
                    knowledge.search("body")
                with self.assertRaises(KnowledgeDisabledError):
                    knowledge.prepare_generation()
            finally:
                db.close()

    def test_url_and_numeric_limits_fail_closed(self):
        valid = KnowledgeEmbeddingConfig(
            base_url="http://127.12.0.1:8080/v1",
            model="embed",
            api_key="secret",
            dimensions=384,
            batch_size=32,
        ).validated(require_enabled=True)
        self.assertEqual(valid.base_url, "http://127.12.0.1:8080/v1")

        for url in (
            "http://localhost:8080/v1",
            "http://10.0.0.2/v1",
            "https://user:password@example.com/v1",
            "https://example.com/v1?key=secret",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                KnowledgeEmbeddingConfig(
                    base_url=url,
                    model="embed",
                    api_key="secret",
                ).validated(require_enabled=True)
        with self.assertRaises(ValueError):
            KnowledgeEmbeddingConfig(
                base_url="https://example.com/v1",
                model="embed",
                api_key="secret",
                dimensions=0,
            ).validated(require_enabled=True)
        with self.assertRaises(ValueError):
            KnowledgeEmbeddingConfig(
                base_url="https://example.com/v1",
                model="embed",
                api_key="secret",
                batch_size=257,
            ).validated(require_enabled=True)

    def test_openai_response_requires_ordered_finite_vectors(self):
        requests = []

        def transport(url, headers, body, timeout, maximum):
            requests.append((url, headers, json.loads(body), timeout, maximum))
            return (
                200,
                "application/json; charset=utf-8",
                json.dumps({
                    "data": [
                        {"index": 0, "embedding": [1.0, 0.0]},
                        {"index": 1, "embedding": [0.0, 1.0]},
                    ]
                }).encode(),
            )

        client = OpenAIEmbeddingClient(
            KnowledgeEmbeddingConfig(
                base_url="https://embeddings.example/v1",
                model="embed-v1",
                api_key="do-not-log",
                dimensions=2,
            ),
            transport=transport,
        )
        self.assertEqual(client.embed(["first", "second"]), [[1.0, 0.0], [0.0, 1.0]])
        self.assertEqual(requests[0][0], "https://embeddings.example/v1/embeddings")
        self.assertEqual(
            requests[0][2],
            {
                "model": "embed-v1",
                "input": ["first", "second"],
                "dimensions": 2,
            },
        )

        def unordered(*_args):
            return (
                200,
                "application/json",
                json.dumps({
                    "data": [
                        {"index": 1, "embedding": [1.0, 0.0]},
                        {"index": 0, "embedding": [0.0, 1.0]},
                    ]
                }).encode(),
            )

        with self.assertRaises(EmbeddingResponseError):
            OpenAIEmbeddingClient(client.config, transport=unordered).embed(
                ["first", "second"]
            )

        invalid_vectors = (
            [float("nan"), 1.0],
            [1.0],
            ["not-a-number", 1.0],
            [0.0, 0.0],
        )
        for vector in invalid_vectors:
            with self.subTest(vector=vector):
                def invalid(*_args, returned=vector):
                    return (
                        200,
                        "application/json",
                        json.dumps({
                            "data": [{"index": 0, "embedding": returned}]
                        }).encode(),
                    )

                with self.assertRaises(EmbeddingResponseError):
                    OpenAIEmbeddingClient(client.config, transport=invalid).embed(
                        ["first"]
                    )


class KnowledgeChunkingTests(unittest.TestCase):
    def test_markdown_chunking_is_stable_and_preserves_provenance(self):
        content = (
            "# Overview\n\n"
            + "alpha sentence. " * 70
            + "\n\n## Details\n\n"
            + "beta sentence. " * 70
        )
        first = chunk_document(document_id=7, title="Runbook", content=content)
        second = chunk_document(document_id=7, title="Runbook", content=content)

        self.assertEqual(first, second)
        self.assertGreater(len(first), 1)
        self.assertEqual([chunk.chunk_index for chunk in first], list(range(len(first))))
        for chunk in first:
            self.assertEqual(content[chunk.char_start : chunk.char_end], chunk.content)
            self.assertLessEqual(len(chunk.content), knowledge_module.CHUNK_TARGET_CHARS)
            self.assertRegex(chunk.chunk_id, r"^[0-9a-f]{64}$")
        self.assertTrue(first[0].title_path.startswith("Runbook > Overview"))
        self.assertTrue(any("Details" in chunk.title_path for chunk in first))


class KnowledgeIndexTests(unittest.TestCase):
    def test_generation_indexes_atomically_and_vector_search_survives_restart(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "kb.db"
            db = Database(path)
            client = FakeEmbeddingClient()
            try:
                knowledge = configured_knowledge(db, client)
                alpha, _ = knowledge.add_document_with_status(
                    title="Alpha Guide",
                    content="# Alpha\n\nalpha deployment procedure",
                    source="runbook",
                )
                beta, _ = knowledge.add_document_with_status(
                    title="Beta Guide",
                    content="# Beta\n\nbeta incident procedure",
                    source="runbook",
                )
                pending = queued_index_payloads(db)
                self.assertEqual(
                    {item["document_id"] for item in pending},
                    {alpha["id"], beta["id"]},
                )
                generation_id = pending[0]["generation_id"]
                results = [knowledge.index_document(item) for item in pending]

                self.assertTrue(results[-1]["activated"])
                self.assertEqual(
                    db.scalar(
                        "SELECT count(*) FROM knowledge_index_generations "
                        "WHERE status = 'active'"
                    ),
                    1,
                )
                hits = knowledge.search("alpha")
                self.assertEqual(hits[0].document_id, alpha["id"])
                self.assertTrue(hits[0].chunk_id)
                self.assertGreaterEqual(hits[0].char_start, 0)
                public_hit = hits[0].to_dict()
                self.assertEqual(public_hit["document_id"], alpha["id"])
                self.assertIn("alpha", public_hit["excerpt"].casefold())
                self.assertEqual(public_hit["char_start"], hits[0].char_start)
                self.assertEqual(public_hit["char_end"], hits[0].char_end)
                self.assertNotIn("content", public_hit)
                status = knowledge.status()
                self.assertEqual(status["state"], "ready")
                self.assertEqual(status["active_generation_id"], generation_id)
                self.assertEqual(status["indexed_documents"], 2)
            finally:
                db.close()

            reopened = Database(path)
            try:
                restored = configured_knowledge(reopened, FakeEmbeddingClient())
                self.assertEqual(
                    restored.search("beta")[0].document_id,
                    beta["id"],
                )
            finally:
                reopened.close()

    def test_shadow_generation_does_not_replace_active_until_complete(self):
        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "kb.db")
            try:
                knowledge = configured_knowledge(db)
                alpha, _ = knowledge.add_document_with_status(
                    title="Alpha", content="alpha reference"
                )
                for payload in queued_index_payloads(db):
                    knowledge.index_document(payload)
                old_generation = knowledge.status()["active_generation_id"]

                new_generation = knowledge.prepare_generation(force=True)
                pending = queued_index_payloads(db, new_generation)
                self.assertEqual(len(pending), 1)
                self.assertEqual(knowledge.status()["active_generation_id"], old_generation)
                self.assertEqual(
                    knowledge.search("alpha")[0].document_id,
                    alpha["id"],
                )
                result = knowledge.index_document(pending[0])
                self.assertTrue(result["activated"])
                self.assertEqual(
                    knowledge.status()["active_generation_id"],
                    new_generation,
                )
                self.assertEqual(knowledge.search("alpha")[0].document_id, alpha["id"])
            finally:
                db.close()

    def test_stale_hash_is_discarded_without_writing_vectors(self):
        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "kb.db")
            try:
                knowledge = configured_knowledge(db)
                document, _ = knowledge.add_document_with_status(
                    title="Mutable",
                    content="alpha original",
                )
                payload = queued_index_payloads(db)[0]
                replacement = "beta replacement"
                replacement_hash = knowledge._content_hash(
                    document["title"], replacement, document["source"]
                )
                db.execute(
                    "UPDATE knowledge_documents SET content = ?, content_hash = ? "
                    "WHERE id = ?",
                    (replacement, replacement_hash, document["id"]),
                )

                result = knowledge.index_document(payload)

                self.assertEqual(result["status"], "stale")
                self.assertEqual(
                    db.scalar(
                        "SELECT count(*) FROM knowledge_chunks WHERE generation_id = ?",
                        (payload["generation_id"],),
                    ),
                    0,
                )
            finally:
                db.close()

    def test_invalid_fake_vectors_are_rejected(self):
        class WrongCount:
            def embed(self, _texts):
                return []

        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "kb.db")
            try:
                knowledge = configured_knowledge(db, WrongCount())
                knowledge.add_document_with_status(
                    title="Alpha", content="alpha body"
                )
                payload = queued_index_payloads(db)[0]
                with self.assertRaises(EmbeddingResponseError):
                    knowledge.index_document(payload)
                knowledge.mark_index_failed(payload, "invalid provider response")
                status = knowledge.status()
                self.assertEqual(status["state"], "degraded")
                self.assertEqual(status["pending_documents"], 0)
                self.assertEqual(status["failed_documents"], 1)
            finally:
                db.close()


class KnowledgeDedupAndLimitsTests(unittest.TestCase):
    def test_identical_document_is_deduped_concurrently(self):
        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "kb.db")
            try:
                knowledge = configured_knowledge(db)
                barrier = threading.Barrier(2)
                results = []
                errors = []

                def insert():
                    try:
                        barrier.wait()
                        results.append(knowledge.add_document_with_status(
                            title="Runbook",
                            content="alpha procedure",
                            source="wiki",
                        ))
                    except BaseException as exc:
                        errors.append(exc)

                threads = [threading.Thread(target=insert) for _ in range(2)]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join(5)

                self.assertEqual(errors, [])
                self.assertEqual({item[0]["id"] for item in results}, {results[0][0]["id"]})
                self.assertEqual(sum(1 for _doc, created in results if created), 1)
            finally:
                db.close()

    def test_content_exceeding_cap_raises_without_insert(self):
        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "kb.db")
            original = knowledge_module.MAX_CONTENT_CHARS
            knowledge_module.MAX_CONTENT_CHARS = 16
            try:
                knowledge = configured_knowledge(db)
                with self.assertRaises(ValueError):
                    knowledge.add_document_with_status(
                        title="Oversize", content="x" * 100
                    )
                self.assertEqual(db.scalar("SELECT count(*) FROM knowledge_documents"), 0)
            finally:
                knowledge_module.MAX_CONTENT_CHARS = original
                db.close()

    def test_cap_resolver_reads_env_and_defaults(self):
        previous = os.environ.get("AGENT_PLATFORM_KB_MAX_CONTENT_CHARS")
        try:
            os.environ["AGENT_PLATFORM_KB_MAX_CONTENT_CHARS"] = "42"
            self.assertEqual(knowledge_module._resolve_max_content_chars(), 42)
            os.environ["AGENT_PLATFORM_KB_MAX_CONTENT_CHARS"] = "not-an-int"
            self.assertEqual(
                knowledge_module._resolve_max_content_chars(),
                2_000_000,
            )
        finally:
            if previous is None:
                os.environ.pop("AGENT_PLATFORM_KB_MAX_CONTENT_CHARS", None)
            else:
                os.environ["AGENT_PLATFORM_KB_MAX_CONTENT_CHARS"] = previous


class DatabaseMemoryFtsContractTests(unittest.TestCase):
    def test_startup_repairs_legacy_tags_projection_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "memory.db"
            db = Database(path)
            try:
                if not db.fts_available:
                    self.skipTest("FTS5 not available in this SQLite build")
                memory_id = db.insert(
                    """
                    INSERT INTO agent_memories(
                        scope_key, target, content, tags_json, created_at, updated_at
                    ) VALUES (?, 'memory', ?, ?, ?, ?)
                    """,
                    (
                        "private:1",
                        "stable deployment preference",
                        '["ocean","urgent"]',
                        1,
                        1,
                    ),
                )

                # Reproduce the shipped legacy definition. Its FTS projection
                # names the source column `tags`, although agent_memories only
                # has `tags_json`, so a rebuild or query cannot read content.
                for trigger_name in (
                    "agent_memory_ai",
                    "agent_memory_ad",
                    "agent_memory_au",
                ):
                    db._conn.execute(f'DROP TRIGGER "{trigger_name}"')
                db._conn.execute('DROP TABLE "agent_memory_fts"')
                db._conn.execute(
                    "CREATE VIRTUAL TABLE agent_memory_fts "
                    "USING fts5(content, tags, "
                    "content='agent_memories', content_rowid='id')"
                )
                db._conn.executescript(
                    """
                    CREATE TRIGGER agent_memory_ai AFTER INSERT ON agent_memories BEGIN
                        INSERT INTO agent_memory_fts(rowid, content, tags)
                        VALUES (new.id, new.content, new.tags_json);
                    END;
                    CREATE TRIGGER agent_memory_ad AFTER DELETE ON agent_memories BEGIN
                        INSERT INTO agent_memory_fts(
                            agent_memory_fts, rowid, content, tags
                        ) VALUES ('delete', old.id, old.content, old.tags_json);
                    END;
                    CREATE TRIGGER agent_memory_au AFTER UPDATE ON agent_memories BEGIN
                        INSERT INTO agent_memory_fts(
                            agent_memory_fts, rowid, content, tags
                        ) VALUES ('delete', old.id, old.content, old.tags_json);
                        INSERT INTO agent_memory_fts(rowid, content, tags)
                        VALUES (new.id, new.content, new.tags_json);
                    END;
                    """
                )
                db._conn.commit()
                self.assertEqual(
                    [
                        str(row["name"])
                        for row in db._conn.execute(
                            'PRAGMA table_info("agent_memory_fts")'
                        ).fetchall()
                    ],
                    ["content", "tags"],
                )
            finally:
                db.close()

            repaired = Database(path)
            try:
                self.assertTrue(repaired.fts_available)
                self.assertEqual(
                    [
                        str(row["name"])
                        for row in repaired._conn.execute(
                            'PRAGMA table_info("agent_memory_fts")'
                        ).fetchall()
                    ],
                    ["content", "tags_json"],
                )
                self.assertEqual(
                    repaired.scalar(
                        "SELECT count(*) FROM agent_memory_fts_docsize"
                    ),
                    1,
                )
                result = repaired.query_one(
                    """
                    SELECT m.id FROM agent_memory_fts
                    JOIN agent_memories m ON m.id = agent_memory_fts.rowid
                    WHERE agent_memory_fts MATCH ?
                    """,
                    ("ocean",),
                )
                self.assertEqual(int(result["id"]), memory_id)

                # The repaired UPDATE trigger must delete old terms and index
                # the new tags_json value using the same canonical projection.
                repaired.execute(
                    "UPDATE agent_memories SET tags_json = ? WHERE id = ?",
                    ('["violet"]', memory_id),
                )
                self.assertIsNotNone(
                    repaired.query_one(
                        "SELECT rowid FROM agent_memory_fts "
                        "WHERE agent_memory_fts MATCH ?",
                        ("violet",),
                    )
                )
                schema_version = int(repaired.scalar("PRAGMA schema_version"))
            finally:
                repaired.close()

            reopened = Database(path)
            try:
                # A second startup proves the canonical objects and performs no
                # replacement DDL.
                self.assertEqual(
                    int(reopened.scalar("PRAGMA schema_version")), schema_version
                )
            finally:
                reopened.close()


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

    def test_commit_failure_rolls_back_and_connection_remains_reusable(self):
        class FailFirstCommit:
            def __init__(self, connection):
                self.connection = connection
                self.failed = False
                self.rollbacks = 0

            def __getattr__(self, name):
                return getattr(self.connection, name)

            def commit(self):
                if not self.failed:
                    self.failed = True
                    raise sqlite3.OperationalError("simulated disk full during commit")
                return self.connection.commit()

            def rollback(self):
                self.rollbacks += 1
                return self.connection.rollback()

        with tempfile.TemporaryDirectory() as td:
            db = Database(Path(td) / "kb.db")
            try:
                holder = db._local.holder
                proxy = FailFirstCommit(holder.conn)
                holder.conn = proxy
                with self.assertRaises(sqlite3.OperationalError):
                    with db.transaction() as conn:
                        conn.execute(
                            "INSERT INTO knowledge_documents"
                            "(title, summary, content, source, created_at, updated_at)"
                            " VALUES (?, ?, ?, ?, ?, ?)",
                            ("NotCommitted", "", "body", "", 1, 1),
                        )
                self.assertEqual(proxy.rollbacks, 1)
                self.assertEqual(self._count(db), 0)

                with db.transaction() as conn:
                    conn.execute(
                        "INSERT INTO knowledge_documents"
                        "(title, summary, content, source, created_at, updated_at)"
                        " VALUES (?, ?, ?, ?, ?, ?)",
                        ("Recovered", "", "body", "", 1, 1),
                    )
                self.assertEqual(self._count(db), 1)
            finally:
                db.close()


if __name__ == "__main__":
    unittest.main()
