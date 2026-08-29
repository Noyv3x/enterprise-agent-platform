from __future__ import annotations

import errno
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from enterprise_agent_platform import secure_fs
from enterprise_agent_platform.secure_fs import (
    UnsafePrivatePathError,
    ensure_private_directory,
    ensure_private_file,
    open_private_directory_fd,
    publish_private_file_at,
    read_private_file_at,
    validate_atomic_replace_support,
    write_private_file_exclusive,
)


class SecureFilesystemTests(unittest.TestCase):
    def test_atomic_support_check_never_exchanges_existing_probe_names(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            root.chmod(0o700)
            staging = root / "isolated"
            staging.mkdir(mode=0o700)
            final_probe = root / ".atomic-replace-support-probe"
            staging_probe = staging / ".atomic-replace-support-probe"
            final_probe.write_bytes(b"final-unknown")
            staging_probe.write_bytes(b"staging-unknown")
            final_probe.chmod(0o600)
            staging_probe.chmod(0o600)
            parent_fd = open_private_directory_fd(root)
            staging_fd = open_private_directory_fd(staging)
            try:
                with mock.patch.object(
                    secure_fs,
                    "_rename_exchange",
                    side_effect=AssertionError("named probe must not exchange"),
                ):
                    validate_atomic_replace_support(parent_fd, staging_fd)
                self.assertEqual(final_probe.read_bytes(), b"final-unknown")
                self.assertEqual(staging_probe.read_bytes(), b"staging-unknown")
            finally:
                os.close(staging_fd)
                os.close(parent_fd)

    def test_directory_and_file_permissions_are_tightened(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "data"
            root.mkdir(mode=0o755)
            ensure_private_directory(root)
            self.assertEqual(root.stat().st_mode & 0o777, 0o700)

            target = root / "secret"
            target.write_text("value", encoding="utf-8")
            target.chmod(0o644)
            ensure_private_file(target)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_private_directory_rejects_symlink(self):
        if not hasattr(os, "symlink"):
            self.skipTest("symlinks are not supported")
        with tempfile.TemporaryDirectory() as td:
            real = Path(td) / "real"
            real.mkdir()
            link = Path(td) / "link"
            link.symlink_to(real, target_is_directory=True)
            with self.assertRaises(RuntimeError):
                ensure_private_directory(link)

    def test_exclusive_writer_never_replaces_existing_file(self):
        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / "attachment.bin"
            write_private_file_exclusive(target, b"first")
            self.assertEqual(target.read_bytes(), b"first")
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                write_private_file_exclusive(target, b"second")
            self.assertEqual(target.read_bytes(), b"first")

    def test_atomic_replacement_restores_a_raced_final_entry(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            root.chmod(0o700)
            staging = root / "isolated"
            staging.mkdir(mode=0o700)
            final = root / "marker.json"
            final.write_bytes(b"old")
            final.chmod(0o600)
            parent_fd = open_private_directory_fd(root)
            staging_fd = open_private_directory_fd(staging)
            try:
                _, expected = read_private_file_at(
                    parent_fd, "marker.json", maximum_bytes=16
                )
                real_exchange = secure_fs._rename_exchange

                def exchange_with_race(left_fd, left_name, right_fd, right_name):
                    final.rename(root / "marker-old-away.json")
                    final.write_bytes(b"attacker")
                    final.chmod(0o600)
                    return real_exchange(left_fd, left_name, right_fd, right_name)

                with mock.patch.object(
                    secure_fs,
                    "_rename_exchange",
                    side_effect=exchange_with_race,
                ):
                    with self.assertRaisesRegex(
                        UnsafePrivatePathError, "raced with replacement"
                    ):
                        publish_private_file_at(
                            parent_fd,
                            "marker.json",
                            b"new",
                            replace_identity=(expected.st_dev, expected.st_ino),
                            replace_data=b"old",
                            staging_fd=staging_fd,
                            staging_name="marker.stage",
                        )
                # The exchange publishes only a complete file. Because the
                # captured inode was not the expected one, no unconditional
                # second exchange is attempted: both sides are retained for
                # explicit recovery.
                self.assertEqual(final.read_bytes(), b"new")
                self.assertEqual((root / "marker-old-away.json").read_bytes(), b"old")
                self.assertEqual((staging / "marker.stage").read_bytes(), b"attacker")
            finally:
                os.close(staging_fd)
                os.close(parent_fd)

    def test_post_exchange_final_race_retains_the_expected_old_inode(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            root.chmod(0o700)
            staging = root / "isolated"
            staging.mkdir(mode=0o700)
            final = root / "marker.json"
            final.write_bytes(b"old")
            final.chmod(0o600)
            parent_fd = open_private_directory_fd(root)
            staging_fd = open_private_directory_fd(staging)
            try:
                _, expected = read_private_file_at(
                    parent_fd, "marker.json", maximum_bytes=16
                )
                real_exchange = secure_fs._rename_exchange

                def exchange_then_race(left_fd, left_name, right_fd, right_name):
                    real_exchange(left_fd, left_name, right_fd, right_name)
                    final.rename(root / "marker-new-away.json")
                    final.write_bytes(b"attacker")
                    final.chmod(0o600)

                with mock.patch.object(
                    secure_fs,
                    "_rename_exchange",
                    side_effect=exchange_then_race,
                ):
                    with self.assertRaisesRegex(
                        UnsafePrivatePathError, "raced after replacement"
                    ):
                        publish_private_file_at(
                            parent_fd,
                            "marker.json",
                            b"new",
                            replace_identity=(expected.st_dev, expected.st_ino),
                            replace_data=b"old",
                            staging_fd=staging_fd,
                            staging_name="marker.stage",
                        )
                self.assertEqual(final.read_bytes(), b"attacker")
                self.assertEqual((root / "marker-new-away.json").read_bytes(), b"new")
                self.assertEqual((staging / "marker.stage").read_bytes(), b"old")
            finally:
                os.close(staging_fd)
                os.close(parent_fd)

    def test_complete_isolated_staging_is_retryable_after_interruption(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            root.chmod(0o700)
            staging = root / "isolated"
            staging.mkdir(mode=0o700)
            final = root / "marker.json"
            final.write_bytes(b"old")
            final.chmod(0o600)
            parent_fd = open_private_directory_fd(root)
            staging_fd = open_private_directory_fd(staging)
            try:
                _, expected = read_private_file_at(
                    parent_fd, "marker.json", maximum_bytes=16
                )
                def fail_real_exchange(left_fd, left_name, right_fd, right_name):
                    raise RuntimeError("simulated crash boundary")

                with mock.patch.object(
                    secure_fs,
                    "_rename_exchange",
                    side_effect=fail_real_exchange,
                ):
                    with self.assertRaisesRegex(RuntimeError, "crash boundary"):
                        publish_private_file_at(
                            parent_fd,
                            "marker.json",
                            b"new",
                            replace_identity=(expected.st_dev, expected.st_ino),
                            replace_data=b"old",
                            staging_fd=staging_fd,
                            staging_name="marker.stage",
                        )
                self.assertEqual(final.read_bytes(), b"old")
                self.assertEqual((staging / "marker.stage").read_bytes(), b"new")

                publish_private_file_at(
                    parent_fd,
                    "marker.json",
                    b"new",
                    replace_identity=(expected.st_dev, expected.st_ino),
                    replace_data=b"old",
                    staging_fd=staging_fd,
                    staging_name="marker.stage",
                )
                self.assertEqual(final.read_bytes(), b"new")
                self.assertEqual(list(staging.iterdir()), [])
            finally:
                os.close(staging_fd)
                os.close(parent_fd)

    def test_unsupported_exchange_preserves_transaction_bound_staging(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            root.chmod(0o700)
            staging = root / "isolated"
            staging.mkdir(mode=0o700)
            final = root / "marker.json"
            final.write_bytes(b"old")
            final.chmod(0o600)
            parent_fd = open_private_directory_fd(root)
            staging_fd = open_private_directory_fd(staging)
            try:
                _, expected = read_private_file_at(
                    parent_fd, "marker.json", maximum_bytes=16
                )
                with mock.patch.object(
                    secure_fs,
                    "_rename_exchange",
                    side_effect=OSError(errno.EOPNOTSUPP, "unsupported"),
                ):
                    with self.assertRaisesRegex(
                        UnsafePrivatePathError, "replacement is unsupported"
                    ):
                        publish_private_file_at(
                            parent_fd,
                            "marker.json",
                            b"new",
                            replace_identity=(expected.st_dev, expected.st_ino),
                            replace_data=b"old",
                            staging_fd=staging_fd,
                            staging_name="marker.stage",
                        )
                self.assertEqual(final.read_bytes(), b"old")
                self.assertEqual((staging / "marker.stage").read_bytes(), b"new")
            finally:
                os.close(staging_fd)
                os.close(parent_fd)


if __name__ == "__main__":
    unittest.main()
