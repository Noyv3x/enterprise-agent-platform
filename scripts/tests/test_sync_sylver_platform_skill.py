from __future__ import annotations

import importlib.util
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).parents[1] / "sync_sylver_platform_skill.py"
SPEC = importlib.util.spec_from_file_location("sync_sylver_platform_skill", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)


class SylverPlatformSkillSyncTests(unittest.TestCase):
    def test_token_must_be_an_owner_only_regular_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            token_file = root / "token"
            token_file.write_text("github-token\n", encoding="utf-8")
            token_file.chmod(0o600)
            self.assertEqual(sync.read_private_token(token_file), "github-token")

            token_file.chmod(0o644)
            with self.assertRaisesRegex(sync.SyncError, "owner-only regular file"):
                sync.read_private_token(token_file)

            token_file.unlink()
            target = root / "target"
            target.write_text("github-token", encoding="utf-8")
            target.chmod(0o600)
            token_file.symlink_to(target)
            with self.assertRaisesRegex(sync.SyncError, "owner-only regular file"):
                sync.read_private_token(token_file)

    def test_authentication_uses_process_environment_not_remote_url(self) -> None:
        environment, header = sync.git_auth_environment("github-token")
        self.assertEqual(environment["GIT_CONFIG_KEY_0"], "http.extraHeader")
        self.assertEqual(environment["GIT_CONFIG_VALUE_0"], header)
        self.assertEqual(environment["GIT_CONFIG_COUNT"], "3")
        self.assertEqual(environment["GIT_CONFIG_KEY_1"], "http.followRedirects")
        self.assertEqual(environment["GIT_CONFIG_VALUE_1"], "false")
        self.assertEqual(environment["GIT_CONFIG_KEY_2"], "credential.helper")
        self.assertEqual(environment["GIT_CONFIG_VALUE_2"], "")
        self.assertNotIn("github-token", "https://github.com/example/private.git")
        self.assertNotIn("github-token", header)

    def test_contract_requires_pinned_credential_free_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            contract_path = root / sync.CONTRACT_PATH
            contract_path.parent.mkdir(parents=True)
            contract_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "sources": {
                            sync.SOURCE_NAME: {
                                "repository_url": sync.EXPECTED_REPOSITORY_URL,
                                "tracking_ref": "refs/heads/master",
                                "revision": "1" * 40,
                                "required_paths": ["SKILL.md", "scripts/ubi.py"],
                                "skill_sha256": "2" * 64,
                                "adapter_sha256": "3" * 64,
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            _contract, source = sync.load_source_contract(root)
            self.assertEqual(source["revision"], "1" * 40)

            for invalid_url in (
                "https://attacker.invalid/private.git",
                "https://github.com/Sylver-Lining/other-private-skill.git",
                "https://token@github.com/Sylver-Lining/ubitech-platform-skill.git",
            ):
                with self.subTest(invalid_url=invalid_url):
                    source["repository_url"] = invalid_url
                    contract_path.write_text(
                        json.dumps(
                            {"schema_version": 1, "sources": {sync.SOURCE_NAME: source}}
                        ),
                        encoding="utf-8",
                    )
                    with self.assertRaisesRegex(sync.SyncError, "fixed official URL"):
                        sync.load_source_contract(root)

    def test_reviewed_lock_update_is_atomic_and_preserves_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / sync.CONTRACT_PATH
            target.parent.mkdir(parents=True)
            contract = {
                "schema_version": 1,
                "sources": {
                    "firecrawl": {"revision": "3" * 40},
                    sync.SOURCE_NAME: {
                        "revision": "1" * 40,
                        "skill_sha256": "2" * 64,
                        "adapter_sha256": "3" * 64,
                    },
                },
            }
            target.write_text(json.dumps(contract), encoding="utf-8")

            sync.update_reviewed_lock(
                root,
                contract,
                revision="4" * 40,
                skill_digest="5" * 64,
                adapter_digest="6" * 64,
            )

            saved = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(saved["sources"]["firecrawl"]["revision"], "3" * 40)
            self.assertEqual(saved["sources"][sync.SOURCE_NAME]["revision"], "4" * 40)
            self.assertEqual(
                saved["sources"][sync.SOURCE_NAME]["skill_sha256"], "5" * 64
            )
            self.assertEqual(
                saved["sources"][sync.SOURCE_NAME]["adapter_sha256"], "6" * 64
            )
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o644)
            self.assertEqual(os.listdir(target.parent), [target.name])

    def test_cold_fetch_authenticates_every_blob_materialization(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            git_directory = Path(directory)
            checkout = git_directory / sync.DEFAULT_CHECKOUT_RELATIVE_PATH
            calls: list[tuple[list[str], dict[str, str] | None]] = []
            revision = "7" * 40
            source = {
                "repository_url": sync.EXPECTED_REPOSITORY_URL,
                "tracking_ref": "refs/heads/master",
                "revision": "1" * 40,
                "required_paths": [sync.SKILL_PATH, sync.ADAPTER_PATH],
            }

            def fake_git(arguments, *, cwd, environment=None, binary=False, secrets=()):
                calls.append((list(arguments), environment))
                if arguments[0] == "clone":
                    checkout.mkdir(parents=True)
                    return b"" if binary else ""
                if arguments[:3] == ["config", "--get", "remote.origin.url"]:
                    return source["repository_url"] + "\n"
                if arguments[0] == "rev-parse":
                    return revision + "\n"
                if arguments[0] == "show":
                    return b"skill" if arguments[1].endswith(sync.SKILL_PATH) else b"adapter"
                if arguments[0] == "diff":
                    return " two files changed\n"
                return b"" if binary else ""

            with mock.patch.object(sync, "_git", side_effect=fake_git):
                fetched, skill, adapter, _stat = sync.fetch_upstream(
                    git_directory,
                    source,
                    "github-token",
                )

            self.assertEqual((fetched, skill, adapter), (revision, b"skill", b"adapter"))
            clone = next(arguments for arguments, _env in calls if arguments[0] == "clone")
            self.assertNotIn("--filter=blob:none", clone)
            for arguments, environment in calls:
                if arguments[0] in {"fetch", "rev-parse", "cat-file", "show", "diff"}:
                    self.assertIsNotNone(environment, arguments)
                    self.assertEqual(
                        (environment or {}).get("GIT_CONFIG_KEY_0"),
                        "http.extraHeader",
                    )
                    self.assertEqual(
                        (environment or {}).get("GIT_CONFIG_VALUE_1"),
                        "false",
                    )
                    self.assertEqual(
                        (environment or {}).get("GIT_CONFIG_VALUE_2"),
                        "",
                    )


if __name__ == "__main__":
    unittest.main()
