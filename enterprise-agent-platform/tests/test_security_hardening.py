from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from enterprise_agent_platform import service as service_module
from enterprise_agent_platform.internal_config import mask_value
from enterprise_agent_platform.service import (
    EnterpriseService,
    ServiceError,
    UploadedFile,
    mask_secret,
)

from test_platform import RecordingAgent, make_config


class MaskSecretTests(unittest.TestCase):
    """The mask must never leak the exact length or a prefix of a secret."""

    def test_short_secret_uses_fixed_width_mask(self):
        # A secret under 12 chars renders as a fixed-width mask, so the rendered
        # hint encodes neither the length nor any character of the secret.
        self.assertEqual(mask_secret("abc"), "********")
        self.assertEqual(mask_secret("hunter2"), "********")
        self.assertEqual(mask_value("abc"), "********")
        self.assertEqual(mask_value("hunter2"), "********")

    def test_two_different_short_secrets_mask_identically(self):
        # Different short secrets of different lengths must be indistinguishable
        # once masked (no length oracle, no prefix leak).
        self.assertEqual(mask_secret("a"), mask_secret("abcdefghijk"))
        self.assertEqual(mask_value("a"), mask_value("abcdefghijk"))
        self.assertEqual(mask_secret("short"), mask_secret("other"))

    def test_long_secret_only_shows_suffix_and_no_prefix(self):
        # Long secrets expose only a short trailing suffix as a recognition hint;
        # the prefix must never appear in the mask.
        secret = "sk-PREFIXsecretmiddleSUFFIX9999"
        masked = mask_secret(secret)
        self.assertTrue(masked.startswith("..."))
        self.assertEqual(masked, "...9999")
        self.assertNotIn("PREFIX", masked)
        self.assertNotIn("sk-", masked)
        # Same contract from internal_config.mask_value.
        self.assertEqual(mask_value(secret), "...9999")

    def test_long_secrets_of_different_length_do_not_reveal_length(self):
        # Two long secrets that share a 4-char suffix mask identically even though
        # their lengths differ, so the mask cannot be used to infer length.
        short_long = "AAAAAAAAAAAA1234"
        long_long = "BBBBBBBBBBBBBBBBBBBBBBBBBBBB1234"
        self.assertEqual(mask_secret(short_long), mask_secret(long_long))
        self.assertEqual(mask_secret(short_long), "...1234")

    def test_empty_secret_masks_to_empty(self):
        self.assertEqual(mask_secret(""), "")
        self.assertEqual(mask_value(""), "")

    def test_list_secrets_never_emits_plaintext_or_length(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                short_value = "key12"
                long_value = "sk-confidentialPLAINTEXTtail99"
                service.set_secret(admin, "API_SERVER_KEY", short_value)
                service.set_secret(admin, "CODEX_OAUTH_ACCESS_TOKEN", long_value)
                items = {item["key"]: item for item in service.list_secrets(admin)}
                short_item = items["API_SERVER_KEY"]
                long_item = items["CODEX_OAUTH_ACCESS_TOKEN"]
                self.assertTrue(short_item["configured"])
                self.assertEqual(short_item["masked"], "********")
                self.assertEqual(long_item["masked"], "...il99")
                # No masked rendering may contain the plaintext body.
                self.assertNotIn(short_value, short_item["masked"])
                self.assertNotIn("confidential", long_item["masked"])
                self.assertNotIn("PLAINTEXT", long_item["masked"])
            finally:
                service.close()


class LoginLimiterTests(unittest.TestCase):
    def test_correct_password_not_locked_out_by_distributed_brute_force(self):
        # A distributed brute force rotating client_ids can push the per-account
        # ceiling over its limit, but a CORRECT credential from a fresh client
        # must still authenticate (no remote account-lockout DoS), while a WRONG
        # password from a fresh client is throttled with 429.
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                # Drive more distinct-client wrong-password attempts than the
                # per-account ceiling. Each client stays under the per-client
                # ceiling so it is only the per-user accumulator that trips.
                ceiling = service_module.MAX_LOGIN_FAILURES_PER_USER
                for i in range(ceiling + 5):
                    with self.assertRaises(ServiceError) as ctx:
                        service.authenticate("admin", "wrong-password", client_id=f"client-{i}")
                    # Until the per-user ceiling is reached it is a 401; once the
                    # accumulator is over the ceiling subsequent wrong attempts
                    # surface as 429.
                    self.assertIn(ctx.exception.status, (401, 429))

                # A wrong password from yet another fresh client is now 429.
                with self.assertRaises(ServiceError) as wrong_ctx:
                    service.authenticate("admin", "still-wrong", client_id="client-fresh-wrong")
                self.assertEqual(wrong_ctx.exception.status, 429)

                # The correct password from a brand-new client still works.
                token, user = service.authenticate("admin", "admin", client_id="client-honest")
                self.assertTrue(token)
                self.assertEqual(user["username"], "admin")
            finally:
                service.close()

    def test_per_client_limit_still_blocks_single_source_brute_force(self):
        # The per-(user, client) limiter must still 429 a single source that
        # exceeds MAX_LOGIN_FAILURES wrong attempts, even before the per-user
        # ceiling is involved.
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                limit = service_module.MAX_LOGIN_FAILURES
                statuses = []
                for _ in range(limit + 2):
                    with self.assertRaises(ServiceError) as ctx:
                        service.authenticate("admin", "nope", client_id="same-client")
                    statuses.append(ctx.exception.status)
                # The first few are 401 (invalid credential); once the per-client
                # window fills, the source is throttled with 429.
                self.assertIn(429, statuses)
            finally:
                service.close()

    def test_login_failure_maps_are_bounded(self):
        # Usernames/clients are attacker-controlled even for invalid logins; a
        # flood of distinct keys must not grow the in-memory maps without bound.
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                with mock.patch.object(service_module, "MAX_LOGIN_FAILURE_KEYS", 16):
                    for i in range(80):
                        # Distinct username AND distinct client each iteration so
                        # both maps would grow unbounded without the eviction.
                        with self.assertRaises(ServiceError):
                            service.authenticate(f"user{i}", "wrong", client_id=f"c{i}")
                    self.assertLessEqual(
                        len(service._login_failures), service_module.MAX_LOGIN_FAILURE_KEYS
                    )
                    self.assertLessEqual(
                        len(service._login_failures_by_user),
                        service_module.MAX_LOGIN_FAILURE_KEYS,
                    )
            finally:
                service.close()

    def test_nonexistent_user_returns_401_like_wrong_password(self):
        # Username enumeration: a nonexistent (but syntactically valid) username
        # must produce the same 401 as a wrong password for a real user.
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                with self.assertRaises(ServiceError) as missing_ctx:
                    service.authenticate("ghost_user", "whatever", client_id="cid")
                self.assertEqual(missing_ctx.exception.status, 401)

                with self.assertRaises(ServiceError) as wrong_ctx:
                    service.authenticate("admin", "definitely-wrong", client_id="cid2")
                self.assertEqual(wrong_ctx.exception.status, 401)
                # The error message must not distinguish the two cases.
                self.assertEqual(
                    str(missing_ctx.exception), str(wrong_ctx.exception)
                )
            finally:
                service.close()


class AttachmentLimitTests(unittest.TestCase):
    def test_attachment_quota_exceeded_raises_413(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, user = service.authenticate("admin", "admin")
                # Tiny per-uploader storage budget so a single normal-sized blob
                # blows the quota.
                with mock.patch.object(service_module, "ATTACHMENT_QUOTA_BYTES", 32):
                    with self.assertRaises(ServiceError) as ctx:
                        service.send_channel_message(
                            user,
                            1,
                            "here is a file",
                            [UploadedFile("big.bin", "application/octet-stream", b"x" * 64)],
                        )
                    self.assertEqual(ctx.exception.status, 413)
                # The orphaned message must have been rolled back, so the channel
                # has no stored messages.
                self.assertEqual(service.list_messages(user, "channel", "1"), [])
            finally:
                service.close()

    def test_too_many_attachments_per_message_raises_400(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, user = service.authenticate("admin", "admin")
                limit = service_module.MAX_ATTACHMENTS_PER_MESSAGE
                attachments = [
                    UploadedFile(f"f{i}.txt", "text/plain", b"data")
                    for i in range(limit + 1)
                ]
                with self.assertRaises(ServiceError) as ctx:
                    service.send_channel_message(user, 1, "lots of files", attachments)
                self.assertEqual(ctx.exception.status, 400)
            finally:
                service.close()

    def test_oversized_single_attachment_raises_413(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, user = service.authenticate("admin", "admin")
                # Shrink the per-attachment cap so a small blob trips the 413.
                with mock.patch.object(service_module, "MAX_ATTACHMENT_BYTES", 8):
                    with self.assertRaises(ServiceError) as ctx:
                        service.send_private_message(
                            user,
                            "oversized",
                            [UploadedFile("big.bin", "application/octet-stream", b"x" * 64)],
                        )
                    self.assertEqual(ctx.exception.status, 413)
            finally:
                service.close()


class UploadRateLimitTests(unittest.TestCase):
    def test_second_attachment_message_in_window_raises_429_but_text_does_not(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, user = service.authenticate("admin", "admin")
                with mock.patch.object(service_module, "MAX_UPLOADS_PER_WINDOW", 1):
                    # First attachment-bearing message consumes the only slot.
                    first = service.send_channel_message(
                        user,
                        1,
                        "first upload",
                        [UploadedFile("a.txt", "text/plain", b"hello")],
                    )
                    self.assertEqual(first["user_message"]["attachments"][0]["filename"], "a.txt")

                    # A plain text message must NOT be throttled: ordinary chat is
                    # unaffected by the upload limiter.
                    plain = service.send_channel_message(user, 1, "just talking, no files")
                    self.assertEqual(plain["user_message"]["content"], "just talking, no files")

                    # A second attachment-bearing message in the same window is 429.
                    with self.assertRaises(ServiceError) as ctx:
                        service.send_channel_message(
                            user,
                            1,
                            "second upload",
                            [UploadedFile("b.txt", "text/plain", b"world")],
                        )
                    self.assertEqual(ctx.exception.status, 429)
            finally:
                service.close()


if __name__ == "__main__":
    unittest.main()
