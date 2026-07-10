from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from enterprise_agent_platform.secure_fs import (
    ensure_private_directory,
    ensure_private_file,
    write_private_file_exclusive,
)


class SecureFilesystemTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
