from __future__ import annotations

import hashlib
import io
import os
import stat
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from enterprise_agent_platform.secure_fs import copy_private_file_exclusive
from enterprise_agent_platform.server import (
    EnterpriseHTTPServer,
    RequestHandler,
    _parse_multipart_upload,
)
from enterprise_agent_platform.service import EnterpriseService, ServiceError, UploadedFile


def multipart_body(boundary: str, payload: bytes) -> bytes:
    return (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="content"\r\n\r\n'
        "stream this\r\n"
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="files"; filename="payload.bin"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode("ascii") + payload + f"\r\n--{boundary}--\r\n".encode("ascii")


class FragmentedReader(io.BytesIO):
    def __init__(self, data: bytes, fragment_bytes: int = 17):
        super().__init__(data)
        self.fragment_bytes = fragment_bytes
        self.largest_request = 0

    def read(self, size: int = -1) -> bytes:
        if size < 0:
            raise AssertionError("multipart parser attempted an unbounded read")
        self.largest_request = max(self.largest_request, size)
        return super().read(min(size, self.fragment_bytes))


class TimeoutReader:
    def read(self, _size: int = -1) -> bytes:
        raise TimeoutError("simulated idle socket")


class FakeConnection:
    def __init__(self):
        self.timeout = 60

    def gettimeout(self):
        return self.timeout

    def settimeout(self, timeout):
        self.timeout = timeout


class UploadStreamingTests(unittest.TestCase):
    def test_multipart_file_is_streamed_to_private_staging(self):
        boundary = "----ubitech-stream-test"
        # Include a boundary-looking sequence with an invalid suffix and split
        # every wire read aggressively; it must remain attachment payload.
        payload = (
            (b"0123456789" * 32_768)
            + f"\r\n--{boundary}Xtail\r\n--{boundary}--Xtail".encode("ascii")
        )
        body = multipart_body(boundary, payload)
        source = FragmentedReader(body)

        with tempfile.TemporaryDirectory() as td:
            staging_root = Path(td) / "data" / "upload-staging"
            content, attachments, request_dir = _parse_multipart_upload(
                source,
                length=len(body),
                content_type=f"multipart/form-data; boundary={boundary}",
                staging_root=staging_root,
            )

            self.assertEqual(content, "stream this")
            self.assertEqual(len(attachments), 1)
            attachment = attachments[0]
            self.assertIsNone(attachment.data)
            self.assertEqual(attachment.byte_size, len(payload))
            self.assertEqual(attachment.sha256, hashlib.sha256(payload).hexdigest())
            self.assertEqual(attachment.staged_path.read_bytes(), payload)
            self.assertEqual(stat.S_IMODE(staging_root.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(request_dir.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(attachment.staged_path.stat().st_mode), 0o600)
            if hasattr(os, "getuid"):
                self.assertEqual(attachment.staged_path.stat().st_uid, os.getuid())
            self.assertLessEqual(source.largest_request, 64 * 1024)

    def test_disconnect_removes_partial_staging_file(self):
        boundary = "----ubitech-disconnect-test"
        complete = multipart_body(boundary, b"partial payload")
        truncated = complete[:-12]

        with tempfile.TemporaryDirectory() as td:
            staging_root = Path(td) / "data" / "upload-staging"
            with self.assertRaises(ServiceError):
                _parse_multipart_upload(
                    FragmentedReader(truncated),
                    length=len(complete),
                    content_type=f"multipart/form-data; boundary={boundary}",
                    staging_root=staging_root,
                )
            self.assertEqual(list(staging_root.iterdir()), [])

    def test_staged_upload_is_revalidated_without_materializing_bytes(self):
        with tempfile.TemporaryDirectory() as td:
            data_root = Path(td) / "data"
            source = data_root / "upload-staging" / "request-test" / "source"
            destination = Path(td) / "destination"
            payload = b"disk-backed upload"
            source.parent.mkdir(parents=True)
            source.write_bytes(payload)
            source.chmod(0o600)
            digest = hashlib.sha256(payload).hexdigest()
            upload = UploadedFile(
                "upload.txt",
                "text/plain",
                data=None,
                staged_path=source,
                size_bytes=len(payload),
                sha256=digest,
            )

            service = SimpleNamespace(config=SimpleNamespace(data_dir=data_root))
            normalized = EnterpriseService._normalize_uploaded_files(service, [upload])
            self.assertIsNone(normalized[0].data)
            self.assertEqual(normalized[0].byte_size, len(payload))
            size, copied_digest = copy_private_file_exclusive(
                source,
                destination,
                expected_size=len(payload),
                expected_sha256=digest,
            )
            self.assertEqual(size, len(payload))
            self.assertEqual(copied_digest, digest)
            self.assertEqual(destination.read_bytes(), payload)

    def test_digest_mismatch_never_leaves_partial_destination(self):
        with tempfile.TemporaryDirectory() as td:
            source = Path(td) / "source"
            destination = Path(td) / "destination"
            source.write_bytes(b"changed")
            source.chmod(0o600)

            with self.assertRaises(RuntimeError):
                copy_private_file_exclusive(
                    source,
                    destination,
                    expected_size=7,
                    expected_sha256="0" * 64,
                )
            self.assertFalse(destination.exists())

    def test_service_rejects_staging_outside_platform_data_root(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            data_root = root / "data"
            (data_root / "upload-staging").mkdir(parents=True)
            outside = root / "outside"
            outside.write_bytes(b"not an upload staging file")
            upload = UploadedFile(
                "outside.txt",
                "text/plain",
                data=None,
                staged_path=outside,
                size_bytes=outside.stat().st_size,
                sha256=hashlib.sha256(outside.read_bytes()).hexdigest(),
            )
            service = SimpleNamespace(config=SimpleNamespace(data_dir=data_root))

            with self.assertRaises(ServiceError):
                EnterpriseService._normalize_uploaded_files(service, [upload])

    def test_upload_has_an_independent_nonblocking_budget(self):
        server = object.__new__(EnterpriseHTTPServer)
        server._upload_slots = threading.BoundedSemaphore(1)

        self.assertTrue(server.acquire_upload_slot())
        self.assertFalse(server.acquire_upload_slot())
        server.release_upload_slot()
        self.assertTrue(server.acquire_upload_slot())
        server.release_upload_slot()

    def test_request_cleanup_removes_staging_and_releases_upload_slot(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "upload-staging"
            request_dir = root / "request-test"
            request_dir.mkdir(parents=True)
            (request_dir / "part-0001").write_bytes(b"partial")
            release = mock.Mock()
            handler = object.__new__(RequestHandler)
            handler.server = SimpleNamespace(
                upload_staging_root=root,
                release_upload_slot=release,
            )
            handler._upload_staging_dirs = [request_dir]
            handler._upload_slot_held = True

            handler._cleanup_upload_request()

            self.assertFalse(request_dir.exists())
            self.assertFalse(handler._upload_slot_held)
            release.assert_called_once_with()

    def test_socket_idle_timeout_is_reported_and_cleans_request_state(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "data" / "upload-staging"
            root.mkdir(parents=True)
            release = mock.Mock()
            forbidden_admission = mock.Mock()
            handler = object.__new__(RequestHandler)
            handler.server = SimpleNamespace(
                upload_staging_root=root,
                acquire_upload_slot=lambda: True,
                release_upload_slot=release,
                service=SimpleNamespace(
                    _begin_agent_update_admission=forbidden_admission,
                ),
            )
            handler.connection = FakeConnection()
            handler.rfile = TimeoutReader()
            handler._content_length = lambda: 128
            handler._upload_staging_dirs = []
            handler._upload_slot_held = False

            with self.assertRaises(ServiceError) as raised:
                handler._body_multipart_message(
                    "multipart/form-data; boundary=----ubitech-timeout-test"
                )
            self.assertEqual(raised.exception.status, 408)
            self.assertEqual(handler.connection.timeout, 60)
            self.assertEqual(list(root.iterdir()), [])
            forbidden_admission.assert_not_called()

            handler._cleanup_upload_request()
            release.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
