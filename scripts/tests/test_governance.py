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
        self.fake('docs_sync.py', scripts / 'docs_sync.py')
        front = self.root / 'enterprise-agent-platform/frontend'
        front.mkdir(parents=True)
        for name in ('package.json', 'package-lock.json'):
            (front / name).write_text('{}\n')
        self.fake('git')
        self.fake('npm')
        self.env['FIXTURE_SCENARIO'] = scenario
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

    def gate_repository(self):
        scripts = self.root / 'scripts'
        scripts.mkdir()
        shutil.copyfile(ROOT / 'scripts/test.sh', scripts / 'test.sh')
        for name in ('docs_sync.py', 'python_test_shard.py', 'container-smoke.sh'):
            self.fake(name, scripts / name)
        tests = scripts / 'tests'
        tests.mkdir()
        (tests / 'test_child.py').write_text(
            'import os\nfrom pathlib import Path\nimport unittest\n'
            'class ScriptProbe(unittest.TestCase):\n'
            '    def test_child(self):\n'
            '        with Path(os.environ["FIXTURE_ROOT"], "scripts-runs").open("a") as log:\n'
            '            log.write("run\\n")\n'
            '        self.assertNotEqual(os.environ.get("FIXTURE_SCENARIO"), "scripts-fail")\n'
        )
        platform = self.root / 'enterprise-agent-platform'
        (platform / 'enterprise_agent_platform').mkdir(parents=True)
        (platform / 'tests').mkdir()
        (self.root / 'manager').mkdir()
        for component in ('agent-runtime', 'camofox-runtime', 'frontend'):
            directory = platform / component
            (directory / 'src').mkdir(parents=True)
            for name in ('package.json', 'package-lock.json'):
                (directory / name).write_text('{}\n')
        (platform / 'frontend/src/example.ts').write_text('export const value = 1;\n')
        (self.root / 'README.md').write_text('# Gate fixture\n')
        (self.root / '.gitignore').write_text(
            'bin/\nnode_modules/\n__pycache__/\ncalls.jsonl\nscripts-runs\n'
            'agent-platform-tests.*/\n'
        )
        for command in ('npm', 'go', 'docker'):
            self.fake(command)
        self.env['FIXTURE_SCENARIO'] = 'control'
        self.run_process('git', 'init', '--quiet', check=True)
        self.run_process('git', 'add', '--all', check=True)
        self.run_process(
            'git', '-c', 'user.email=fixture@example.invalid',
            '-c', 'user.name=Gate Fixture', 'commit', '--quiet', '-m', 'baseline',
            check=True,
        )

    def run_gate(self, mode='affected'):
        return self.run_process('bash', str(self.root / 'scripts/test.sh'), mode)

    def test_full_runs_script_suite_once_and_propagates_its_failure(self):
        self.gate_repository()
        self.env['FIXTURE_SCENARIO'] = 'scripts-fail'
        failed = self.run_gate('full')
        self.assertNotEqual(failed.returncode, 0, failed.stdout + failed.stderr)
        self.assertIn('FAIL scripts', failed.stderr)
        self.assertEqual((self.root / 'scripts-runs').read_text(), 'run\n')
        self.env['FIXTURE_SCENARIO'] = 'control'
        passed = self.run_gate('full')
        self.assertEqual(passed.returncode, 0, passed.stdout + passed.stderr)
        self.assertEqual((self.root / 'scripts-runs').read_text(), 'run\nrun\n')
        self.assertEqual(
            [call for call in self.calls() if call[0] == 'docs_sync.py'],
            [['docs_sync.py', 'check'], ['docs_sync.py', 'check']],
        )

    def test_document_only_gate_still_checks_the_current_tree(self):
        self.gate_repository()
        (self.root / 'README.md').write_text('# Updated gate fixture\n')
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.calls(), [['docs_sync.py', 'check']])
        self.env['FIXTURE_SCENARIO'] = 'docs-fail'
        failed = self.run_gate()
        self.assertNotEqual(failed.returncode, 0, failed.stdout + failed.stderr)
        self.assertFalse((self.root / 'scripts-runs').exists())

    def test_shared_and_unknown_paths_select_all_gate_components(self):
        self.gate_repository()
        for relative in ('scripts/container-smoke.sh', 'containers/compose.yaml', 'unknown/input'):
            with self.subTest(path=relative):
                path = self.root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                original = path.read_bytes() if path.exists() else None
                path.write_bytes((original or b'') + b'\n# changed shared input\n')
                result = self.run_gate()
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                for component in ('scripts', 'manager', 'python', 'runtime', 'camofox', 'frontend', 'containers'):
                    self.assertRegex(result.stdout, rf'(?m)^PASS {component}\s')
                if original is None:
                    path.unlink()
                else:
                    path.write_bytes(original)

    def test_cross_component_rename_runs_both_owners(self):
        self.gate_repository()
        self.run_process(
            'git', 'mv', 'enterprise-agent-platform/frontend/src/example.ts',
            'enterprise-agent-platform/agent-runtime/src/example.ts', check=True,
        )
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertRegex(result.stdout, r'(?m)^PASS frontend\s')
        self.assertRegex(result.stdout, r'(?m)^PASS runtime\s')
        self.assertFalse((self.root / 'scripts-runs').exists())

    def test_staged_change_unstaged_revert_and_untracked_file_are_all_selected(self):
        self.gate_repository()
        path = self.root / 'enterprise-agent-platform/frontend/src/example.ts'
        original = path.read_bytes()
        path.write_text('export const value = 2;\n')
        self.run_process('git', 'add', str(path), check=True)
        path.write_bytes(original)
        (self.root / 'enterprise-agent-platform/tests/test_new.py').write_text('# untracked\n')
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertRegex(result.stdout, r'(?m)^PASS frontend\s')
        self.assertRegex(result.stdout, r'(?m)^PASS python\s')
        self.assertFalse((self.root / 'scripts-runs').exists())

    def test_failed_git_enumeration_cannot_report_an_empty_gate(self):
        self.gate_repository()
        self.fake('git')
        self.env['FIXTURE_SCENARIO'] = 'git-fail'
        result = self.run_gate()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn('Selected checks:', result.stdout)
        self.assertFalse((self.root / 'scripts-runs').exists())

    def release_repository(self):
        self.repository = self.root / 'source'
        self.repository.mkdir()
        self.run_process('git', 'init', '--quiet', '--initial-branch=main', cwd=self.repository, check=True)
        scripts = self.repository / 'scripts'
        scripts.mkdir()
        shutil.copyfile(ROOT / 'scripts/release_eligibility.py', scripts / 'release_eligibility.py')
        contract = self.repository / 'docs/contracts/upstream-sources.json'
        contract.parent.mkdir(parents=True)
        shutil.copyfile(ROOT / 'docs/contracts/upstream-sources.json', contract)
        baseline = self.release_commit('product.py', 'VALUE = 1\n')
        remote = self.root / 'origin.git'
        self.run_process('git', 'init', '--bare', '--quiet', str(remote), check=True)
        self.run_process('git', 'remote', 'add', 'origin', str(remote), cwd=self.repository, check=True)
        self.push_release_source()
        self.fake('gh')
        return baseline

    def release_commit(self, relative, content):
        path = self.repository / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        self.run_process('git', 'add', '--all', cwd=self.repository, check=True)
        self.run_process(
            'git', '-c', 'user.email=fixture@example.invalid',
            '-c', 'user.name=Release Fixture', 'commit', '--quiet', '-m', relative,
            cwd=self.repository, check=True,
        )
        return self.run_process('git', 'rev-parse', 'HEAD', cwd=self.repository, check=True).stdout.strip()

    def push_release_source(self):
        self.run_process('git', 'push', '--quiet', 'origin', 'HEAD:main', cwd=self.repository, check=True)

    def prepare(self, published, *, event='workflow_run', quality_changes=None, scenario='control'):
        source = self.run_process('git', 'rev-parse', 'HEAD', cwd=self.repository, check=True).stdout.strip()
        quality = {
            'id': 123, 'run_attempt': 1, 'path': '.github/workflows/quality.yml',
            'event': 'push', 'status': 'completed', 'conclusion': 'success',
            'head_branch': 'main', 'head_sha': source,
            'head_repository': {'full_name': 'fixture/example'},
        }
        quality.update(quality_changes or {})
        (self.root / 'quality-response.json').write_text(json.dumps(quality))
        output = self.root / 'prepare-output'
        self.env.update(
            RUNNER_TEMP=str(self.root), SOURCE_COMMIT=source,
            GITHUB_OUTPUT=str(output), GITHUB_REPOSITORY='fixture/example',
            GITHUB_EVENT_NAME=event, UPSTREAM_RUN_ID='123', UPSTREAM_RUN_ATTEMPT='1',
            FIXTURE_LATEST_TAG='container-' + published, FIXTURE_SCENARIO=scenario,
            GH_TOKEN='offline-fixture-not-a-credential',
        )
        outputs = {}
        for name in (
            'Resolve immutable release inputs',
            'Revalidate the exact successful Quality run',
            'Determine cumulative release eligibility',
        ):
            output.unlink(missing_ok=True)
            body = step_body(name).replace('${{ github.repository }}', 'fixture/example')
            result = self.run_process('bash', '-c', body, cwd=self.repository)
            if output.exists():
                outputs.update(line.split('=', 1) for line in output.read_text().splitlines())
            if result.returncode:
                return result, outputs
            self.env['SOURCE_COMMIT'] = outputs['source_commit']
            self.env['PUBLISHED_COMMIT'] = outputs['published_commit']
        return result, outputs

    def test_prepare_classifies_cumulative_unpublished_product_changes(self):
        published = self.release_repository()
        product = self.release_commit('product.py', 'VALUE = 2\n')
        self.release_commit('docs/design/fixture.md', '# Prose only\n')
        self.push_release_source()
        required, outputs = self.prepare(published)
        self.assertEqual(required.returncode, 0, required.stdout + required.stderr)
        self.assertEqual(outputs['release_required'], 'true')
        noop, outputs = self.prepare(product)
        self.assertEqual(noop.returncode, 0, noop.stdout + noop.stderr)
        self.assertEqual(outputs['release_required'], 'false')
        for call in self.calls():
            self.assertNotIn(call[1:3], (['release', 'create'], ['release', 'upload'], ['release', 'edit']))
            self.assertNotIn('--method', call, 'no-op preparation must not create tags or releases')

    def test_prepare_rejects_candidate_outside_main_and_nonancestor_latest(self):
        published = self.release_repository()
        candidate = self.release_commit('product.py', 'VALUE = 2\n')
        unqualified, outputs = self.prepare(published)
        self.assertNotEqual(unqualified.returncode, 0, unqualified.stdout + unqualified.stderr)
        self.assertNotIn('release_required', outputs)
        self.push_release_source()
        self.run_process('git', 'checkout', '--quiet', published, cwd=self.repository, check=True)
        backwards, outputs = self.prepare(candidate)
        self.assertNotEqual(backwards.returncode, 0, backwards.stdout + backwards.stderr)
        self.assertNotIn('release_required', outputs)

    def test_prepare_requires_exact_successful_quality_identity(self):
        published = self.release_repository()
        for changes in (
            {'path': '.github/workflows/unrelated.yml'},
            {'conclusion': 'failure'},
            {'head_sha': 'c' * 40},
            {'head_repository': {'full_name': 'other/repository'}},
            {'run_attempt': 2},
        ):
            with self.subTest(changes=changes):
                result, outputs = self.prepare(published, quality_changes=changes)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertNotIn('release_required', outputs)

    def test_prepare_latest_read_failure_is_not_a_prose_noop(self):
        published = self.release_repository()
        result, outputs = self.prepare(published, scenario='latest-fail')
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn('release_required', outputs)

    def test_manual_prepare_forces_release_only_for_current_qualified_main(self):
        published = self.release_repository()
        forced, outputs = self.prepare(published, event='workflow_dispatch')
        self.assertEqual(forced.returncode, 0, forced.stdout + forced.stderr)
        self.assertEqual(outputs['release_required'], 'true')
        self.release_commit('docs/design/fixture.md', '# New main\n')
        self.push_release_source()
        self.run_process('git', 'checkout', '--quiet', published, cwd=self.repository, check=True)
        stale, outputs = self.prepare(published, event='workflow_dispatch')
        self.assertNotEqual(stale.returncode, 0, stale.stdout + stale.stderr)
        self.assertNotIn('release_required', outputs)

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

    def integration_catalog_fixture(self):
        lines = WORKFLOW.read_text().splitlines()
        start = next(
            index for index, line in enumerate(lines)
            if line.startswith('  PINNED_INTEGRATION_IMAGES:')
        )
        encoded = []
        for line in lines[start + 1:]:
            if line and not line.startswith('    '):
                break
            encoded.append(line[4:])
        pins = json.loads('\n'.join(encoded))
        contract = self.root / 'docs/contracts/container-platform.json'
        contract.parent.mkdir(parents=True)
        shutil.copyfile(ROOT / 'docs/contracts/container-platform.json', contract)
        metadata = self.root / 'image-metadata'
        metadata.mkdir()
        built = {}
        for component in ('platform', 'agent-runtime', 'camofox', 'agent-sandbox'):
            reference = 'registry.example/' + component
            digest = 'sha256:' + 'd' * 64
            (metadata / f'{component}.json').write_text(json.dumps({
                'reference': reference, 'digest': digest,
            }))
            built[component] = reference + '@' + digest
        self.fake('docker')
        return pins, built

    def test_changed_integration_pin_is_both_inspected_and_published_in_catalog(self):
        pins, built = self.integration_catalog_fixture()
        pins['searxng'] = 'registry.example/changed-searxng@sha256:' + 'e' * 64
        self.env['PINNED_INTEGRATION_IMAGES'] = json.dumps(pins)
        preflight = self.run_process(
            'bash', '-c', step_body('Verify immutable integration image indexes exist'),
        )
        self.assertEqual(preflight.returncode, 0, preflight.stdout + preflight.stderr)
        catalog = self.run_process(
            'bash', '-c', step_body('Assemble closed-world managed image catalog'),
        )
        self.assertEqual(catalog.returncode, 0, catalog.stdout + catalog.stderr)
        self.assertEqual(
            json.loads((self.root / 'managed-images.json').read_text()),
            {**built, **pins},
        )
        inspected = [
            call[4] for call in self.calls()
            if call[:4] == ['docker', 'buildx', 'imagetools', 'inspect']
        ]
        self.assertCountEqual(inspected, list(pins.values()))

    def test_catalog_rejects_missing_foreign_or_overlapping_integration_keys(self):
        pins, _ = self.integration_catalog_fixture()
        missing = dict(pins)
        reference = missing.pop('searxng')
        for invalid in (missing, {**missing, 'foreign': reference}, {**missing, 'platform': reference}):
            with self.subTest(keys=sorted(invalid)):
                self.env['PINNED_INTEGRATION_IMAGES'] = json.dumps(invalid)
                result = self.run_process(
                    'bash', '-c', step_body('Assemble closed-world managed image catalog'),
                )
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_malformed_integration_json_cannot_pass_either_consumer(self):
        self.integration_catalog_fixture()
        self.env['PINNED_INTEGRATION_IMAGES'] = '{invalid'
        for step in (
            'Verify immutable integration image indexes exist',
            'Assemble closed-world managed image catalog',
        ):
            with self.subTest(step=step):
                result = self.run_process('bash', '-c', step_body(step))
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.calls(), [])

    def test_integration_preflight_rejects_missing_architecture_and_registry_failure(self):
        pins, _ = self.integration_catalog_fixture()
        self.env['PINNED_INTEGRATION_IMAGES'] = json.dumps(pins)
        for scenario in ('missing-arm64', 'registry-fail'):
            with self.subTest(scenario=scenario):
                self.env['FIXTURE_SCENARIO'] = scenario
                result = self.run_process(
                    'bash', '-c', step_body('Verify immutable integration image indexes exist'),
                )
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)

    def publish(self, scenario, *, already_public=False):
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
        if already_public:
            (self.root / 'already-public').touch()
        result = self.run_process('bash', '-c', step_body('Publish immutable release and advance main'))
        self.assertNotEqual(result.returncode, 97, result.stdout + result.stderr)
        if scenario not in ('own-run', 'download'):
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

    def test_public_replay_compares_bytes_before_and_after_channel_update(self):
        result = self.publish('control', already_public=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        operations = [call[1:3] for call in self.calls() if call[0] == 'gh']
        self.assertEqual(operations.count(['release', 'download']), 2)
        self.assertLess(operations.index(['release', 'download']), operations.index(['release', 'edit']))
        self.assertGreater(
            len(operations) - 1 - operations[::-1].index(['release', 'download']),
            operations.index(['release', 'edit']),
        )

    def test_public_replay_rejects_downloaded_byte_mismatch_before_channel_update(self):
        result = self.publish('download', already_public=True)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('downloaded release asset differs', result.stderr)
        self.assertFalse((self.root / 'published').exists())

    def test_public_replay_rejects_late_asset_identity_drift(self):
        result = self.publish('asset', already_public=True)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.root / 'published').exists())


if __name__ == '__main__':
    unittest.main()
