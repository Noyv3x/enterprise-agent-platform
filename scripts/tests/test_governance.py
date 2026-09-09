"""Offline regressions exercising real governance scripts and workflow shell steps."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
CLI = Path(__file__).parent / 'fixtures' / 'governance_cli.py'
WORKFLOW = ROOT / '.github/workflows/container-release.yml'


def step_body(name: str) -> str:
    lines = WORKFLOW.read_text().splitlines()
    marker = '      - name: ' + name
    start = lines.index(marker)
    run = next(i for i in range(start + 1, len(lines)) if lines[i] == '        run: |')
    body = []
    for line in lines[run + 1:]:
        if line and not line.startswith('          '):
            break
        body.append(line[10:] if line else '')
    return '\n'.join(body) + '\n'


class GovernanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='platform-governance-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.env = {
            'PATH': str(self.bin) + os.pathsep + os.defpath,
            'HOME': str(self.root), 'TMPDIR': str(self.root),
            'LANG': 'C.UTF-8', 'FIXTURE_ROOT': str(self.root),
            'PYTHON_BIN': sys.executable, 'PYTHON': sys.executable,
            'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
            'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_COUNT': '1',
            'GIT_CONFIG_KEY_0': 'core.hooksPath', 'GIT_CONFIG_VALUE_0': '/dev/null',
        }
        # Pin Python to the current interpreter even in a minimal system PATH.
        (self.bin / 'python3').symlink_to(sys.executable)

    def run_process(self, *args, cwd=None, timeout=30, check=False):
        process = subprocess.Popen(args, cwd=cwd or self.root, env=self.env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, start_new_session=True)
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
            self.fail(f'timed out: {args!r}\n{stdout}\n{stderr}')
        result = subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
        if check:
            self.assertEqual(result.returncode, 0, stdout + stderr)
        return result

    def fake(self, name, destination=None):
        path = destination or self.bin / name
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(CLI, path)
        path.chmod(0o755)

    def calls(self):
        path = self.root / 'calls.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def frontend(self, scenario):
        scripts = self.root / 'scripts'
        scripts.mkdir()
        shutil.copyfile(ROOT / 'scripts/test.sh', scripts / 'test.sh')
        front = self.root / 'enterprise-agent-platform/frontend'
        front.mkdir(parents=True)
        for name in ('package.json', 'package-lock.json'):
            (front / name).write_text('{}\n')
        self.fake('git')
        self.fake('npm')
        self.env.update(AGENT_PLATFORM_DOCS_ALREADY_CHECKED='1', FIXTURE_SCENARIO=scenario)
        result = self.run_process('bash', str(scripts / 'test.sh'), 'affected')
        self.assertIn(['npm', 'ci'], self.calls(), result.stdout + result.stderr)
        return front, result

    def test_gov1_frontend_failure_is_not_success(self):
        _, result = self.frontend('test')
        self.assertIn(['npm', 'test'], self.calls())
        self.assertNotIn(['npm', 'run', 'build'], self.calls())
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_gov1_failed_ci_does_not_certify_dependencies(self):
        front, result = self.frontend('ci')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn(['npm', 'run', 'check'], self.calls())
        self.assertFalse((front / 'node_modules/.agent-platform-dependency-fingerprint').exists(),
                         'npm ci exited 42 but dependencies were stamped as successful\n' + result.stdout)

    def docs_snapshot(self):
        # Snapshot tracked working-tree inputs, excluding ignored build/runtime data.
        owned = ['docs', 'scripts', '.github', '.gitignore', 'AGENTS.md', 'claude.md', 'README.md',
                 'install.sh', 'manager', 'containers', 'enterprise-agent-platform']
        tracked = subprocess.run(['git', '-C', str(ROOT), 'ls-files', '-z', '--', *owned],
                                 env=self.env, check=True, capture_output=True, timeout=30).stdout
        for name in tracked.decode().split('\0'):
            if not name:
                continue
            source = ROOT / name
            if not source.is_file():
                continue
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, path)
        for args in [('init', '--quiet'), ('config', 'user.email', 'fixture@example.invalid'),
                     ('config', 'user.name', 'Governance Fixture'), ('add', '--all'),
                     ('commit', '--quiet', '-m', 'baseline')]:
            self.run_process('git', *args, check=True)
        self.run_process(sys.executable, str(self.root / 'scripts/docs_sync.py'),
                         'check-change', '--base', 'HEAD', '--head', 'WORKTREE', check=True)

    def docs_change(self, path, before, after, domain, synchronize_repository=False):
        self.docs_snapshot()
        target = self.root / path
        text = target.read_text()
        self.assertIn(before, text, 'fixture semantic mutation anchor disappeared')
        target.write_text(text.replace(before, after, 1))
        if synchronize_repository:
            document = self.root / 'docs/development/testing.md'
            document.write_text(document.read_text() + '\nFixture: local gate/release selection changed.\n')
        result = self.run_process(sys.executable, str(self.root / 'scripts/docs_sync.py'),
                                  'check-change', '--base', 'HEAD', '--head', 'WORKTREE')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('code changed in domain ' + domain, result.stderr)

    def test_gov2_installer_change_requires_deployment_documentation(self):
        self.docs_change('install.sh', 'set -euo pipefail', 'set -eu', 'deployment')

    def test_gov4_script_change_requires_governance_documentation(self):
        self.docs_change('scripts/test.sh', 'local shard_count=4', 'local shard_count=3',
                         'documentation-governance', synchronize_repository=True)

    def test_gov4_release_change_requires_deployment_documentation(self):
        self.docs_change('.github/workflows/container-release.yml',
                         "needs.prepare.result == 'success'", "needs.prepare.result != 'failure'",
                         'deployment', synchronize_repository=True)

    def upstream(self, change):
        for command in ('git', 'docker'):
            self.fake(command)
        contract = json.loads((ROOT / 'docs/contracts/upstream-sources.json').read_text())
        change(contract['sources']['firecrawl'])
        path = self.root / 'docs/contracts/upstream-sources.json'
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(contract))
        revision = contract['sources']['firecrawl']['revision']
        self.env['FIXTURE_REVISION'] = revision
        body = step_body('Validate exact Firecrawl revision').replace(
            '${{ needs.prepare.outputs.firecrawl_revision }}', revision)
        return self.run_process('bash', '-c', body)

    def test_gov3_required_upstream_file_must_exist(self):
        result = self.upstream(lambda source: source['required_paths'].append('missing-required-file'))
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_gov3_checkout_uses_contract_repository_url(self):
        url = 'https://github.com/governance-fixture/alternate.git'
        result = self.upstream(lambda source: source.update(repository_url=url))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        remotes = [call[-1] for call in self.calls() if call[0] == 'git' and 'remote' in call]
        self.assertEqual(remotes, [url])

    def publish(self, scenario):
        for command in ('gh', 'git'):
            self.fake(command)
        scripts = self.root / 'scripts'
        scripts.mkdir()
        shutil.copyfile(ROOT / 'scripts/ensure-release-candidate-tag.sh',
                        scripts / 'ensure-release-candidate-tag.sh')
        (scripts / 'ensure-release-candidate-tag.sh').chmod(0o755)
        self.fake('verify-release-images-anonymous.sh', scripts / 'verify-release-images-anonymous.sh')
        stage = self.root / 'release'
        stage.mkdir()
        for name in ('agent-platform-compose.yaml', 'agent-platform-manager-linux-amd64',
                     'agent-platform-manager-linux-amd64.sha256', 'agent-platform-manager-linux-arm64',
                     'agent-platform-manager-linux-arm64.sha256', 'install.sh', 'install.sh.sha256', 'release.json'):
            (stage / name).write_text('synthetic asset: ' + name + '\n')
        self.env.update(RUNNER_TEMP=str(self.root), SOURCE_COMMIT='a' * 40,
                        GITHUB_REPOSITORY='fixture/example', GITHUB_EVENT_NAME='workflow_run',
                        GITHUB_RUN_ID='456', GITHUB_RUN_ATTEMPT='1', GITHUB_SHA='a' * 40,
                        GITHUB_REF='refs/heads/main', UPSTREAM_RUN_ID='123', UPSTREAM_RUN_ATTEMPT='1',
                        FIXTURE_SCENARIO=scenario, GH_TOKEN='offline-fixture-not-a-credential')
        result = self.run_process('bash', '-c', step_body('Publish immutable release and advance main'))
        self.assertNotEqual(result.returncode, 97, result.stdout + result.stderr)
        if scenario != 'own-run':
            self.assertTrue((self.root / 'changed').exists(),
                            'fixture did not reach the image-verification interleaving\n' + result.stdout + result.stderr)
        return result

    def test_gov5_asset_identity_drift_is_rejected_before_publication(self):
        result = self.publish('asset')
        self.assertFalse((self.root / 'published').exists(),
                         'release made public after observable asset identity drift\n' + result.stdout + result.stderr)
        self.assertNotEqual(result.returncode, 0)

    def test_gov5_quality_rerun_is_rejected_before_publication(self):
        result = self.publish('quality')
        self.assertFalse((self.root / 'published').exists(),
                         'release made public after Quality advanced to an in-progress attempt\n' + result.stdout + result.stderr)
        self.assertNotEqual(result.returncode, 0)

    def test_gov6_own_run_source_mismatch_is_rejected_before_publication(self):
        # The run API must agree with the current Actions execution identity.
        result = self.publish('own-run')
        self.assertFalse((self.root / 'published').exists(),
                         'release made public despite own run API reporting another source/attempt\n' + result.stdout + result.stderr)
        self.assertNotEqual(result.returncode, 0)

    def test_container_attempt_drift_after_image_verification_blocks_publication(self):
        result = self.publish('own-run-late')
        self.assertFalse((self.root / 'published').exists(), result.stdout + result.stderr)
        self.assertNotEqual(result.returncode, 0)

    def test_publish_control_valid_fixture_is_publishable(self):
        result = self.publish('control')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.root / 'published').exists())


if __name__ == '__main__':
    unittest.main()
