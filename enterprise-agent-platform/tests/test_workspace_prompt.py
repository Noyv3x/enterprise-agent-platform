import unittest
from pathlib import Path
from types import SimpleNamespace

from enterprise_agent_platform.agent_scopes import AgentExecutionScope
from enterprise_agent_platform.service import EnterpriseService


class WorkspacePromptTests(unittest.TestCase):
    def test_redirects_external_install_instructions_to_canonical_paths(self):
        service = EnterpriseService.__new__(EnterpriseService)
        service.config = SimpleNamespace(
            host_data_root=Path("/srv/agent-platform"),
            workspace_internal_directory=".agent-platform",
        )
        scope = AgentExecutionScope(
            scope_key="private:7",
            scope_type="private",
            scope_id="7",
            session_id="session-7",
            lifecycle_id="lifecycle-7",
            workspace_path="/unused/host/path",
            workspace_id="user-7",
            sandbox_id="sandbox-7",
        )

        prompt = service._agent_workspace_prompt(scope)

        for canonical_path in (
            "/workspace/.agent-platform/skills/<id>",
            "/workspace/.agent-platform/mcp.json",
            "/workspace/.agent-platform/mcp/<id>",
        ):
            self.assertIn(canonical_path, prompt)
        self.assertIn(
            ".claude/skills、.claude/skill、用户 HOME 或 .mcp.json",
            prompt,
        )
        self.assertIn("只提取可移植包、命令与参数", prompt)
        self.assertIn("不要创建、复制或维护影子配置", prompt)
        self.assertIn(
            '{"mcpServers":{"<id>":{"command":"...","args":[],"env":{},"cwd":"..."}}}',
            prompt,
        )
        self.assertIn("command 必需，args、env、cwd 可选", prompt)
        self.assertIn(
            "server 包放在 /workspace/.agent-platform/mcp/<id>",
            prompt,
        )
        self.assertIn("skill.create/Skill API 映射成平台包", prompt)
        self.assertIn(
            "缺少 version、category、tags 时分别使用空字符串、空字符串、空数组",
            prompt,
        )
        self.assertIn(
            "支持文件只写入 references、templates、scripts、assets 标准子目录",
            prompt,
        )
        self.assertIn("不要直接复制不兼容的 frontmatter 或 header", prompt)


if __name__ == "__main__":
    unittest.main()
