from __future__ import annotations

import http.client
import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import urlencode

from enterprise_agent_platform.server import serve_in_thread
from enterprise_agent_platform.service import (
    EnterpriseService,
    ServiceError,
    agent_tool_detail,
)

from test_platform import RecordingAgent, make_config


class SkillIntegrationTests(unittest.TestCase):
    def _service(
        self,
        root: Path,
        *,
        agent: RecordingAgent | None = None,
    ) -> EnterpriseService:
        return EnterpriseService(
            make_config(root),
            agent_client=agent or RecordingAgent(),
        )

    @staticmethod
    def _skill_payload(**overrides):
        payload = {
            "name": "Code review",
            "description": "Review changes consistently.",
            "instructions": "# Review\n\nInspect the diff and run focused tests.",
            "category": "engineering",
            "version": "1.0.0",
            "tags": ["review", "quality"],
            "enabled": True,
        }
        payload.update(overrides)
        return payload

    def test_private_skill_crud_is_scoped_and_prompt_index_is_metadata_only(self):
        with tempfile.TemporaryDirectory() as td:
            agent = RecordingAgent()
            service = self._service(Path(td), agent=agent)
            try:
                _, admin = service.authenticate("admin", "admin")
                bob = service.create_user(
                    username="bob",
                    password="bob-pass",
                    display_name="Bob",
                    role="member",
                    actor=admin,
                )
                scope_id = str(admin["id"])
                created = service.user_create_skill(
                    admin,
                    scope_type="private",
                    scope_id=scope_id,
                    body=self._skill_payload(),
                )["skill"]
                skill_id = created["id"]
                self.assertRegex(skill_id, r"^[a-z0-9][a-z0-9-]*$")
                self.assertNotIn("skill_dir", created)
                self.assertNotIn("instructions", created)

                detail = service.user_get_skill(
                    admin,
                    scope_type="private",
                    scope_id=scope_id,
                    skill_id=skill_id,
                )["skill"]
                self.assertIn("Inspect the diff", detail["instructions"])
                self.assertNotIn("skill_dir", detail)

                with self.assertRaises(ServiceError) as forbidden:
                    service.user_get_skill(
                        admin,
                        scope_type="private",
                        scope_id=str(bob["id"]),
                        skill_id=skill_id,
                    )
                self.assertEqual(forbidden.exception.status, 403)

                disabled = service.user_create_skill(
                    admin,
                    scope_type="private",
                    scope_id=scope_id,
                    body=self._skill_payload(
                        name="Disabled procedure",
                        description="This must stay out of the runtime prompt.",
                        enabled=False,
                    ),
                )["skill"]

                service.send_private_message(admin, "Review the latest change.")
                status = service.wait_for_agent_idle(
                    "private",
                    scope_id,
                    timeout=5,
                )
                self.assertEqual(status["state"], "idle")
                available = agent.calls[-1]["metadata"]["available_skills"]
                available_ids = [item["id"] for item in available]
                self.assertIn(skill_id, available_ids)
                available_skill = next(
                    item for item in available if item["id"] == skill_id
                )
                self.assertEqual(
                    set(available_skill),
                    {"id", "name", "description", "category"},
                )
                self.assertNotIn("instructions", json.dumps(available))
                self.assertNotIn(disabled["id"], json.dumps(available))

                updated = service.user_update_skill(
                    admin,
                    scope_type="private",
                    scope_id=scope_id,
                    skill_id=skill_id,
                    body={"name": "Review changes", "enabled": False},
                )["skill"]
                self.assertEqual(updated["id"], skill_id)
                self.assertFalse(updated["enabled"])
                listed = service.user_list_skills(
                    admin,
                    scope_type="private",
                    scope_id=scope_id,
                    query="changes",
                )
                self.assertIn(
                    skill_id,
                    [skill["id"] for skill in listed["skills"]],
                )

                deleted = service.user_delete_skill(
                    admin,
                    scope_type="private",
                    scope_id=scope_id,
                    skill_id=skill_id,
                )
                self.assertEqual(deleted, {"deleted": True, "id": skill_id})
                with self.assertRaises(ServiceError) as missing:
                    service.user_get_skill(
                        admin,
                        scope_type="private",
                        scope_id=scope_id,
                        skill_id=skill_id,
                    )
                self.assertEqual(missing.exception.status, 404)
            finally:
                service.close()

    def test_runtime_skill_tool_enforces_lifecycle_owner_and_disabled_state(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, admin = service.authenticate("admin", "admin")
                scope = service.agent_scopes.ensure_private_scope(int(admin["id"]))
                context = {
                    "scope_key": scope.scope_key,
                    "lifecycle_id": scope.lifecycle_id,
                    "owner_user_id": admin["id"],
                    "run_id": "run-skill",
                }
                create_arguments = self._skill_payload()
                create_arguments.pop("enabled")
                created = service._agent_skill_tool(
                    "create",
                    create_arguments,
                    context,
                )["skill"]
                skill_id = created["id"]

                loaded = service._agent_skill_tool(
                    "load",
                    {"id": skill_id},
                    context,
                )
                self.assertIn("Inspect the diff", loaded["skill"]["instructions"])

                service._agent_skill_tool(
                    "write_file",
                    {
                        "id": skill_id,
                        "file_path": "references/checklist.md",
                        "content": "Check migrations.",
                    },
                    context,
                )
                support = service._agent_skill_tool(
                    "read",
                    {
                        "id": skill_id,
                        "file_path": "references/checklist.md",
                    },
                    context,
                )
                self.assertEqual(support["content"], "Check migrations.")

                service._agent_skill_tool(
                    "disable",
                    {"id": skill_id},
                    context,
                )
                after_disable = service._agent_skill_tool("list", {}, context)
                self.assertNotIn(
                    skill_id,
                    [skill["id"] for skill in after_disable["skills"]],
                )
                self.assertEqual(
                    after_disable["count"],
                    len(after_disable["skills"]),
                )
                second_arguments = {
                    **create_arguments,
                    "name": "Z enabled procedure",
                    "description": "Remain discoverable behind disabled entries.",
                }
                second = service._agent_skill_tool(
                    "create",
                    second_arguments,
                    context,
                )["skill"]
                limited = service._agent_skill_tool(
                    "list",
                    {"limit": 1, "query": "Z enabled procedure"},
                    context,
                )
                self.assertEqual(
                    [skill["id"] for skill in limited["skills"]],
                    [second["id"]],
                )
                with self.assertRaises(ServiceError) as disabled:
                    service._agent_skill_tool(
                        "load",
                        {"id": skill_id},
                        context,
                    )
                self.assertEqual(disabled.exception.status, 409)

                with self.assertRaises(ServiceError) as stale:
                    service._agent_skill_tool(
                        "enable",
                        {"id": skill_id},
                        {**context, "lifecycle_id": "stale"},
                    )
                self.assertEqual(stale.exception.status, 409)
                with self.assertRaises(ServiceError) as redirected:
                    service._agent_skill_tool(
                        "list",
                        {"scope_key": "private:999"},
                        context,
                    )
                self.assertEqual(redirected.exception.status, 400)
                with self.assertRaises(ServiceError) as wrong_owner:
                    service._agent_skill_tool(
                        "list",
                        {},
                        {**context, "owner_user_id": int(admin["id"]) + 1},
                    )
                self.assertEqual(wrong_owner.exception.status, 403)
            finally:
                service.close()

    def test_channel_scope_aliases_resolve_to_one_agent_skill_store(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, admin = service.authenticate("admin", "admin")
                channel = service.create_channel(
                    admin,
                    "skill-scope-alias",
                )
                canonical_id = str(channel["id"])
                alias_id = f"0{canonical_id}"
                created = service.user_create_skill(
                    admin,
                    scope_type="channel",
                    scope_id=alias_id,
                    body=self._skill_payload(),
                )["skill"]
                listed = service.user_list_skills(
                    admin,
                    scope_type="channel",
                    scope_id=canonical_id,
                )
                self.assertEqual(
                    [
                        skill["id"]
                        for skill in listed["skills"]
                        if skill.get("source") == "user"
                    ],
                    [created["id"]],
                )
                canonical_key = service.agent_scopes.channel_scope_key(
                    canonical_id
                )
                alias_key = service.agent_scopes.channel_scope_key(alias_id)
                self.assertIsNotNone(
                    service.agent_scopes.get_scope(canonical_key)
                )
                self.assertIsNone(service.agent_scopes.get_scope(alias_key))

                with self.assertRaises(ServiceError) as invalid:
                    service.user_list_skills(
                        admin,
                        scope_type="channel",
                        scope_id="not-a-channel",
                    )
                self.assertEqual(invalid.exception.status, 400)
            finally:
                service.close()

    def test_channel_viewer_can_read_but_cannot_mutate_skills(self):
        with tempfile.TemporaryDirectory() as td:
            service = self._service(Path(td))
            try:
                _, admin = service.authenticate("admin", "admin")
                viewer_user = service.create_user(
                    username="skill-viewer",
                    password="viewer-pass",
                    display_name="Skill Viewer",
                    permission_group="viewer",
                    actor=admin,
                )
                _, viewer = service.authenticate(
                    viewer_user["username"],
                    "viewer-pass",
                )
                channel = service.create_channel(admin, "skill-viewer-channel")
                channel_id = str(channel["id"])
                created = service.user_create_skill(
                    admin,
                    scope_type="channel",
                    scope_id=channel_id,
                    body=self._skill_payload(),
                )["skill"]

                listed = service.user_list_skills(
                    viewer,
                    scope_type="channel",
                    scope_id=channel_id,
                )
                self.assertEqual(
                    [
                        skill["id"]
                        for skill in listed["skills"]
                        if skill.get("source") == "user"
                    ],
                    [created["id"]],
                )
                with self.assertRaises(ServiceError) as create_denied:
                    service.user_create_skill(
                        viewer,
                        scope_type="channel",
                        scope_id=channel_id,
                        body=self._skill_payload(name="Denied"),
                    )
                self.assertEqual(create_denied.exception.status, 403)
                with self.assertRaises(ServiceError) as update_denied:
                    service.user_update_skill(
                        viewer,
                        scope_type="channel",
                        scope_id=channel_id,
                        skill_id=created["id"],
                        body={"enabled": False},
                    )
                self.assertEqual(update_denied.exception.status, 403)
                with self.assertRaises(ServiceError) as delete_denied:
                    service.user_delete_skill(
                        viewer,
                        scope_type="channel",
                        scope_id=channel_id,
                        skill_id=created["id"],
                    )
                self.assertEqual(delete_denied.exception.status, 403)
            finally:
                service.close()

    def test_skill_http_routes_validate_boolean_and_preserve_slug_id(self):
        with tempfile.TemporaryDirectory() as td:
            config = make_config(Path(td))
            service = EnterpriseService(config, agent_client=RecordingAgent())
            token, admin = service.authenticate("admin", "admin")
            server, thread = serve_in_thread(config, service)
            host, port = server.server_address
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            }
            query = urlencode(
                {
                    "scope_type": "private",
                    "scope_id": str(admin["id"]),
                }
            )

            def request(
                method: str,
                path: str,
                body: dict | None = None,
            ) -> tuple[int, dict]:
                connection = http.client.HTTPConnection(host, port, timeout=5)
                connection.request(
                    method,
                    path,
                    body=json.dumps(body) if body is not None else None,
                    headers=headers,
                )
                response = connection.getresponse()
                payload = json.loads(response.read().decode("utf-8"))
                connection.close()
                return response.status, payload

            try:
                status, invalid = request(
                    "POST",
                    f"/api/agent-skills?{query}",
                    self._skill_payload(enabled="false"),
                )
                self.assertEqual(status, 400)
                self.assertIn("boolean", invalid["error"])

                status, invalid = request(
                    "POST",
                    f"/api/agent-skills?{query}",
                    self._skill_payload(scope_key="private:999"),
                )
                self.assertEqual(status, 400)
                self.assertIn("unsupported", invalid["error"])

                status, created = request(
                    "POST",
                    f"/api/agent-skills?{query}",
                    self._skill_payload(),
                )
                self.assertEqual(status, 201)
                skill_id = created["skill"]["id"]
                self.assertIsInstance(skill_id, str)

                status, invalid = request(
                    "PATCH",
                    f"/api/agent-skills/{skill_id}?{query}",
                    {"name": None},
                )
                self.assertEqual(status, 400)
                self.assertIn("string", invalid["error"])

                status, listed = request(
                    "GET",
                    f"/api/agent-skills?{query}&q=quality&limit=200",
                )
                self.assertEqual(status, 200)
                self.assertIn(
                    skill_id,
                    [skill["id"] for skill in listed["skills"]],
                )

                status, updated = request(
                    "PATCH",
                    f"/api/agent-skills/{skill_id}?{query}",
                    {"enabled": False},
                )
                self.assertEqual(status, 200)
                self.assertFalse(updated["skill"]["enabled"])

                status, deleted = request(
                    "DELETE",
                    f"/api/agent-skills/{skill_id}?{query}",
                )
                self.assertEqual(status, 200)
                self.assertEqual(deleted, {"deleted": True, "id": skill_id})
            finally:
                server.shutdown()
                server.server_close()
                service.close()
                thread.join(timeout=2)

    def test_skill_tool_work_record_never_persists_skill_content(self):
        secret_instructions = "Authorization: Bearer do-not-persist"
        detail = agent_tool_detail(
            {
                "tool_name": "skill",
                "arguments": {
                    "action": "create",
                    "arguments": {
                        "name": "Private process",
                        "description": "Contains a secret process.",
                        "instructions": secret_instructions,
                    },
                },
                "preview": "skill",
            }
        )
        self.assertEqual(detail, "create")
        self.assertNotIn(secret_instructions, detail)


if __name__ == "__main__":
    unittest.main()
