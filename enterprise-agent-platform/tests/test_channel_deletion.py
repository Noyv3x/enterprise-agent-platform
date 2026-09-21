from __future__ import annotations

import http.client
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from enterprise_agent_platform.server import serve_in_thread
from enterprise_agent_platform.service import EnterpriseService, ServiceError, UploadedFile

from test_platform import BlockingAgent, RecordingAgent, make_config


class ChannelDeletionTests(unittest.TestCase):
    def assert_status(self, status, call):
        with self.assertRaises(ServiceError) as raised:
            call()
        self.assertEqual(raised.exception.status, status)

    def test_manager_deletion_retains_content_identity_and_name_but_removes_access(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                service.create_user(
                    username="channel-manager", password="manager-password",
                    display_name="Manager", permission_group="manager", actor=admin,
                )
                _, manager = service.authenticate("channel-manager", "manager-password")
                channel = service.create_channel(admin, "retained-channel")
                channel_id = channel["id"]
                scope_id = str(channel_id)
                sent = service.send_channel_message(
                    admin, channel_id, "@agent retain the source",
                    [UploadedFile("retained.txt", "text/plain", b"retained attachment")],
                )
                service.wait_for_agent_idle("channel", scope_id, timeout=3)
                messages = service.list_messages(admin, "channel", scope_id)
                attachment_id = sent["user_message"]["attachments"][0]["id"]
                _, attachment_path = service.get_attachment_file(admin, attachment_id)
                scope_key = service.agent_scopes.channel_scope_key(scope_id)
                before = service.agent_scopes.get_scope(scope_key)
                retained_file = Path(before.workspace_path) / "retained.txt"
                retained_file.write_text("workspace history", encoding="utf-8")
                retained_session = Path(td) / f"{before.session_id}.jsonl"
                retained_session.write_text("runtime session history", encoding="utf-8")

                def cleanup(_scope_key, *, lifecycle_id=None, delete_sessions=False):
                    # A destructive cleanup would erase the retained fixture.
                    if delete_sessions:
                        retained_session.unlink()
                    return {"scope_key": _scope_key, "cancelled_runs": 0, "sessions_deleted": delete_sessions}

                with mock.patch.object(service.agent_client, "cleanup_scope", side_effect=cleanup):
                    self.assertEqual(service.delete_channel(manager, channel_id), {
                        "deleted": True, "channel_id": channel_id,
                    })
                self.assertNotIn(channel_id, [item["id"] for item in service.list_channels(admin)])
                self.assertEqual(service.agent_scopes.get_scope(scope_key), before)
                self.assertEqual(retained_file.read_text(encoding="utf-8"), "workspace history")
                self.assertEqual(retained_session.read_text(encoding="utf-8"), "runtime session history")
                self.assertEqual(attachment_path.read_bytes(), b"retained attachment")
                self.assertEqual(service._messages_for_scope("channel", scope_id), messages)
                for call in (
                    lambda: service.list_messages(admin, "channel", scope_id),
                    lambda: service.send_channel_message(admin, channel_id, "not accepted"),
                    lambda: service.get_attachment_file(admin, attachment_id),
                    lambda: service.browser_preview_control(admin, {
                        "command": "acquire", "scope_type": "channel",
                        "scope_id": scope_id, "tab_id": "retained-tab",
                    }),
                ):
                    self.assert_status(404, call)
                self.assert_status(409, lambda: service.create_channel(admin, channel["name"]))
                self.assertEqual(service.get_channel(admin, 1)["id"], 1)
            finally:
                service.close()

    def test_delete_revalidates_permission_and_credential_at_commit(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                channel = service.create_channel(admin, "protected-channel")
                for group in ("member", "viewer"):
                    service.create_user(
                        username=group, password="member-password", display_name=group,
                        permission_group=group, actor=admin,
                    )
                    _, actor = service.authenticate(group, "member-password")
                    self.assert_status(403, lambda: service.delete_channel(actor, channel["id"]))
                service.create_user(
                    username="former-manager", password="manager-password", display_name="Manager",
                    permission_group="manager", actor=admin,
                )
                _, manager = service.authenticate("former-manager", "manager-password")
                ingress = service._agent_ingress_lock(service._conversation_key("channel", str(channel["id"])))
                entered = threading.Event()

                def delete():
                    entered.set()
                    return service.delete_channel(manager, channel["id"])

                with ThreadPoolExecutor(max_workers=1) as pool:
                    with ingress:
                        pending = pool.submit(delete)
                        self.assertTrue(entered.wait(timeout=2))
                        service.update_user(admin, manager["id"], {"permission_group": "member"})
                    self.assert_status(401, lambda: pending.result(timeout=3))
                _, downgraded = service.authenticate("former-manager", "manager-password")
                self.assert_status(403, lambda: service.delete_channel(downgraded, channel["id"]))
                self.assertEqual(service.get_channel(admin, channel["id"])["id"], channel["id"])
                self.assert_status(404, lambda: service.delete_channel(admin, 999999))
            finally:
                service.close()

    def test_cleanup_failure_keeps_durable_fence_and_terminal_jobs_and_allows_retry(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                channel = service.create_channel(admin, "retry-cleanup")
                scope_id = str(channel["id"])
                with mock.patch.object(service, "_start_agent_worker_locked"):
                    sent = service.send_channel_message(admin, channel["id"], "@agent queued work")
                job = service.jobs.get_by_key("agent", f"message:{sent['user_message']['id']}")

                def cleanup_failure(*_args, **_kwargs):
                    # Another connection sees both durable changes before the
                    # external cancellation request, not uncommitted state.
                    with ThreadPoolExecutor(max_workers=1) as pool:
                        observed = pool.submit(lambda: (
                            service.db.scalar("SELECT archived FROM channels WHERE id = ?", (channel["id"],)),
                            service.jobs.get(job.id).status,
                        )).result(timeout=2)
                    self.assertEqual(observed, (1, "failed"))
                    raise OSError("cleanup acknowledgement lost")

                with mock.patch.object(service.agent_client, "cleanup_scope", side_effect=cleanup_failure):
                    self.assert_status(503, lambda: service.delete_channel(admin, channel["id"]))
                self.assert_status(404, lambda: service.send_channel_message(admin, channel["id"], "@agent retry input"))
                self.assertEqual(service.jobs.get(job.id).status, "failed")
                self.assertIsNone(service.agent_message_replying_to("channel", scope_id, sent["user_message"]["id"]))
            finally:
                service.close()

            # Retry survives process loss; the archived row is sufficient and
            # neither old input nor failed-job error publication is replayed.
            agent = RecordingAgent()
            restarted = EnterpriseService(config, agent_client=agent)
            try:
                _, admin = restarted.authenticate("admin", "admin")
                self.assertEqual(agent.calls, [])
                self.assertIsNone(restarted.agent_message_replying_to("channel", scope_id, sent["user_message"]["id"]))
                self.assertEqual(restarted.delete_channel(admin, channel["id"]), {
                    "deleted": True, "channel_id": channel["id"],
                })
                self.assertEqual(restarted.jobs.get(job.id).status, "failed")
            finally:
                restarted.close()

    def test_inflight_and_queued_replies_cannot_publish_after_delete_and_sibling_survives(self):
        with tempfile.TemporaryDirectory() as td:
            agent = BlockingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                channel = service.create_channel(admin, "cancel-work")
                scope_id = str(channel["id"])
                first = service.send_channel_message(admin, channel["id"], "@agent active")
                self.assertTrue(agent.started.wait(timeout=2))
                second = service.send_channel_message(admin, channel["id"], "@agent queued")
                sibling = service.send_channel_message(admin, 1, "@agent unaffected")
                service.delete_channel(admin, channel["id"])
                agent.release.set()
                service.wait_for_agent_idle("channel", scope_id, timeout=3)
                service.wait_for_agent_idle("channel", "1", timeout=3)
                for sent in (first, second):
                    message_id = sent["user_message"]["id"]
                    self.assertIsNone(service.agent_message_replying_to("channel", scope_id, message_id))
                    self.assertEqual(service.jobs.get_by_key("agent", f"message:{message_id}").status, "failed")
                self.assertIsNotNone(service.agent_message_replying_to("channel", "1", sibling["user_message"]["id"]))
            finally:
                agent.release.set()
                service.close()

    def test_delete_rejects_unconfirmed_or_mismatched_cleanup_acknowledgement(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                channel = service.create_channel(admin, "acknowledgement")
                scope_key = service.agent_scopes.channel_scope_key(str(channel["id"]))
                confirmed = {"scope_key": scope_key, "cancelled_runs": 0, "sessions_deleted": False}
                for invalid in (
                    {},
                    {**confirmed, "scope_key": "channel:unrelated:main-agent"},
                    {**confirmed, "cancelled_runs": True},
                    {**confirmed, "cancelled_runs": -1},
                    {**confirmed, "sessions_deleted": True},
                ):
                    with self.subTest(acknowledgement=invalid):
                        with mock.patch.object(service.agent_client, "cleanup_scope", return_value=invalid):
                            self.assert_status(503, lambda: service.delete_channel(admin, channel["id"]))
                        self.assert_status(404, lambda: service.get_channel(admin, channel["id"]))
                self.assertEqual(service.delete_channel(admin, channel["id"]), {
                    "deleted": True, "channel_id": channel["id"],
                })
            finally:
                service.close()

    def test_delete_serializes_live_content_and_tool_callback_publication(self):
        for callback_name, payload in (
            ("content_callback", "late streamed response"),
            ("progress_callback", {"type": "tool.started", "tool": "terminal", "toolCallId": "late-tool"}),
        ):
            with self.subTest(callback=callback_name), tempfile.TemporaryDirectory() as td:
                agent = BlockingAgent()
                service = EnterpriseService(make_config(Path(td)), agent_client=agent)
                checked, release, deleting = threading.Event(), threading.Event(), threading.Event()
                try:
                    _, admin = service.authenticate("admin", "admin")
                    channel = service.create_channel(admin, "callback-race")
                    scope_id = str(channel["id"])
                    service.send_channel_message(admin, channel["id"], "@agent live response")
                    self.assertTrue(agent.started.wait(timeout=2))
                    callback = agent.calls[0][callback_name]
                    original = service._task_scope_is_current

                    def paused_check(task, **kwargs):
                        current = original(task, **kwargs)
                        checked.set()
                        if not release.wait(timeout=3):
                            raise TimeoutError("callback was not released")
                        return current

                    def delete():
                        deleting.set()
                        return service.delete_channel(admin, channel["id"])

                    with mock.patch.object(service, "_task_scope_is_current", side_effect=paused_check):
                        with ThreadPoolExecutor(max_workers=2) as pool:
                            publishing = pool.submit(callback, payload)
                            try:
                                self.assertTrue(checked.wait(timeout=2))
                                deletion = pool.submit(delete)
                                self.assertTrue(deleting.wait(timeout=2))
                                # An accepted callback must finish before deletion
                                # commits, never resume writing into cleared state.
                                with self.assertRaises(TimeoutError):
                                    deletion.result(timeout=0.1)
                            finally:
                                release.set()
                            publishing.result(timeout=3)
                            deletion.result(timeout=3)
                    status = service.agent_status_for_system("channel", scope_id)
                    self.assertIsNone(status.get("stream_message"))
                    self.assertEqual(status.get("activity"), [])
                finally:
                    release.set()
                    agent.release.set()
                    service.close()

    def test_delete_during_prompt_preparation_cannot_repopulate_status_or_submit(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            entered, release = threading.Event(), threading.Event()
            try:
                _, admin = service.authenticate("admin", "admin")
                channel = service.create_channel(admin, "prompt-race")
                scope_id = str(channel["id"])
                original = service._channel_system_prompt
                original_barrier = service._runtime_submission_barrier
                observed = []

                def paused_prompt(*args, **kwargs):
                    entered.set()
                    if not release.wait(timeout=3):
                        raise TimeoutError("prompt was not released")
                    return original(*args, **kwargs)

                def observe_submission(task, scope_key):
                    # Read exactly the SSE consumer's projection before worker
                    # settlement could conceal a transient post-delete write.
                    observed.append(service.agent_status_for_system("channel", scope_id))
                    return original_barrier(task, scope_key)

                with mock.patch.object(service, "_channel_system_prompt", side_effect=paused_prompt), mock.patch.object(
                    service, "_runtime_submission_barrier", side_effect=observe_submission
                ):
                    service.send_channel_message(admin, channel["id"], "@agent prepare response")
                    self.assertTrue(entered.wait(timeout=2))
                    service.delete_channel(admin, channel["id"])
                    release.set()
                    service.wait_for_agent_idle("channel", scope_id, timeout=3)
                self.assertEqual(agent.calls, [])
                self.assertFalse(any(status.get("activity") for status in observed))
                status = service.agent_status_for_system("channel", scope_id)
                self.assertEqual(status.get("activity"), [])
                self.assertIsNone(status.get("stream_message"))
            finally:
                release.set()
                service.close()

    def test_delete_wins_before_runtime_submission(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = EnterpriseService(make_config(Path(td)), agent_client=agent)
            entered, release = threading.Event(), threading.Event()
            try:
                _, admin = service.authenticate("admin", "admin")
                channel = service.create_channel(admin, "before-submit")
                scope_id = str(channel["id"])
                original = service._runtime_submission_barrier

                def delayed_barrier(task, scope_key):
                    entered.set()
                    if not release.wait(timeout=3):
                        raise TimeoutError("submission was not released")
                    return original(task, scope_key)

                with mock.patch.object(service, "_runtime_submission_barrier", side_effect=delayed_barrier):
                    sent = service.send_channel_message(admin, channel["id"], "@agent must not start")
                    self.assertTrue(entered.wait(timeout=2))
                    service.delete_channel(admin, channel["id"])
                    release.set()
                    service.wait_for_agent_idle("channel", scope_id, timeout=3)
                self.assertEqual(agent.calls, [])
                self.assertIsNone(service.agent_message_replying_to("channel", scope_id, sent["user_message"]["id"]))
            finally:
                release.set()
                service.close()

    def test_send_enqueue_and_delete_have_one_ingress_order(self):
        with tempfile.TemporaryDirectory() as td:
            service = EnterpriseService(make_config(Path(td)), agent_client=RecordingAgent())
            entered, release, deleting = threading.Event(), threading.Event(), threading.Event()
            try:
                _, admin = service.authenticate("admin", "admin")
                channel = service.create_channel(admin, "send-delete-race")
                original = service._enqueue_after_browser_assistance_handoff

                def delayed_enqueue(*args, **kwargs):
                    entered.set()
                    if not release.wait(timeout=3):
                        raise TimeoutError("enqueue was not released")
                    return original(*args, **kwargs)

                def delete():
                    deleting.set()
                    return service.delete_channel(admin, channel["id"])

                with mock.patch.object(service, "_enqueue_after_browser_assistance_handoff", side_effect=delayed_enqueue), mock.patch.object(service, "_start_agent_worker_locked"):
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        sent_future = pool.submit(service.send_channel_message, admin, channel["id"], "@agent ordered input")
                        self.assertTrue(entered.wait(timeout=2))
                        deleted_future = pool.submit(delete)
                        self.assertTrue(deleting.wait(timeout=2))
                        self.assertFalse(deleted_future.done())
                        release.set()
                        sent = sent_future.result(timeout=3)
                        self.assertTrue(deleted_future.result(timeout=3)["deleted"])
                job = service.jobs.get_by_key("agent", f"message:{sent['user_message']['id']}")
                self.assertEqual(job.status, "failed")
                self.assertEqual(service.agent_client.calls, [])
                self.assert_status(404, lambda: service._enqueue_agent_reply(dict(job.payload)))
                self.assert_status(404, lambda: service.send_channel_message(admin, channel["id"], "late input"))
            finally:
                release.set()
                service.close()

    def test_restart_rejects_archived_queued_payload_even_with_fresh_process_epoch(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            try:
                _, admin = service.authenticate("admin", "admin")
                channel = service.create_channel(admin, "archived-recovery")
                scope_id = str(channel["id"])
                with mock.patch.object(service, "_start_agent_worker_locked"):
                    sent = service.send_channel_message(admin, channel["id"], "@agent stale queued payload")
                job = service.jobs.get_by_key("agent", f"message:{sent['user_message']['id']}")
                # Model a pre-existing archived ledger with a queued payload;
                # recovery must not rely solely on process-local epochs.
                service.db.execute("UPDATE channels SET archived = 1 WHERE id = ?", (channel["id"],))
            finally:
                service.close()
            agent = RecordingAgent()
            restarted = EnterpriseService(config, agent_client=agent)
            try:
                restarted.wait_for_agent_idle("channel", scope_id, timeout=3)
                self.assertEqual(agent.calls, [])
                self.assertEqual(restarted.jobs.get(job.id).status, "failed")
                self.assertIsNone(restarted.agent_message_replying_to("channel", scope_id, sent["user_message"]["id"]))
            finally:
                restarted.close()

    def test_http_delete_preserves_auth_csrf_maintenance_and_retry_contract(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            token, admin = service.authenticate("admin", "admin")
            channel = service.create_channel(admin, "http-delete")
            service.create_user(
                username="member", password="member-password", display_name="Member",
                permission_group="member", actor=admin,
            )
            member_token, _ = service.authenticate("member", "member-password")
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            origin = f"http://{host}:{port}"

            def request(*, auth=token, source=origin, channel_id=channel["id"]):
                connection = http.client.HTTPConnection(host, port, timeout=5)
                try:
                    headers = {}
                    if auth:
                        headers["Cookie"] = f"{config.session_cookie_name}={auth}"
                    if source:
                        headers["Origin"] = source
                    connection.request("DELETE", f"/api/channels/{channel_id}", headers=headers)
                    response = connection.getresponse()
                    return response.status, json.loads(response.read())
                finally:
                    connection.close()

            try:
                self.assertEqual(request(auth=None)[0], 401)
                self.assertEqual(request(auth=member_token)[0], 403)
                self.assertEqual(request(source=None)[0], 403)
                self.assertEqual(request(source="https://foreign.example")[0], 403)
                with mock.patch.object(service, "platform_update_is_blocking", return_value=True):
                    self.assertEqual(request()[0], 503)
                self.assertEqual(service.get_channel(admin, channel["id"])["id"], channel["id"])
                self.assertEqual(request(channel_id=999999)[0], 404)
                with mock.patch.object(service.agent_client, "cleanup_scope", side_effect=OSError("unconfirmed")):
                    self.assertEqual(request()[0], 503)
                self.assertEqual(request(), (200, {"deleted": True, "channel_id": channel["id"]}))
                self.assertEqual(request(), (200, {"deleted": True, "channel_id": channel["id"]}))
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)
