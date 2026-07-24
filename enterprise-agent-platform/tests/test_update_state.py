from __future__ import annotations

import fcntl
import os
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import enterprise_agent_platform.update_state as update_state_module
from enterprise_agent_platform.update_state import (
    heartbeat,
    main as update_state_main,
    mark_container_migration_result,
    mark_failure,
    mark_source_bridge_ready,
    mark_success,
    mark_updating,
    read_state,
    recover_source_bridge_handoff,
    state_lock_path,
    update_state_lock,
)

SOURCE_REVISION = "a" * 40


def _mark_updating(data_dir: Path, update_id: str) -> dict[str, object]:
    return mark_updating(
        data_dir,
        update_id=update_id,
        instance_id="instance-1",
        reason="test",
        target_revision=SOURCE_REVISION,
        remote="origin",
        branch="main",
    )


def _init_update_checkout(
    base: Path,
    deploy_script: Path,
    *,
    old_has_state_helper: bool,
    new_has_state_helper: bool,
) -> tuple[Path, str, str]:
    upstream = base / "upstream"
    upstream.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=upstream, check=True)
    subprocess.run(["git", "checkout", "-q", "-b", "main"], cwd=upstream, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=upstream, check=True)
    subprocess.run(["git", "config", "user.name", "Deploy Test"], cwd=upstream, check=True)
    shutil.copy2(deploy_script, upstream / "deploy.sh")
    (upstream / "version.txt").write_text("old\n", encoding="utf-8")
    helper = upstream / "enterprise-agent-platform" / "enterprise_agent_platform" / "update_state.py"
    if old_has_state_helper:
        helper.parent.mkdir(parents=True)
        helper.write_text("# deployment state protocol fixture\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=upstream, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "old"], cwd=upstream, check=True)
    old_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=upstream, text=True).strip()

    checkout = base / "checkout"
    subprocess.run(["git", "clone", "-q", str(upstream), str(checkout)], check=True)
    (upstream / "version.txt").write_text("new\n", encoding="utf-8")
    if new_has_state_helper and not helper.exists():
        helper.parent.mkdir(parents=True)
        helper.write_text("# deployment state protocol fixture\n", encoding="utf-8")
    elif not new_has_state_helper and helper.exists():
        helper.unlink()
    subprocess.run(["git", "add", "-A"], cwd=upstream, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "new"], cwd=upstream, check=True)
    new_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=upstream, text=True).strip()
    return checkout, old_sha, new_sha


def _fake_deploy_python(base: Path) -> Path:
    executable = base / "fake-python"
    executable.write_text(
        """#!/bin/sh
if [ "${1:-}" = "-m" ] && [ "${2:-}" = "enterprise_agent_platform.update_state" ]; then
  action="${3:-}"
  printf 'state:%s\\n' "$action" >> "$FAKE_DEPLOY_LOG"
  if [ "$action" = "heartbeat" ] && [ "${FAKE_FAIL_HEARTBEAT:-0}" = "1" ]; then
    exit 1
  fi
  if [ "${FAKE_REJECT_STATE_PROTOCOL:-0}" = "1" ]; then
    exit 42
  fi
  exit 0
fi
case "${1:-}" in
  */scripts/docs_sync.py)
    printf 'docs:%s\n' "${2:-}" >> "$FAKE_DEPLOY_LOG"
    exit 0
    ;;
esac
root=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--root" ]; then
    root="$2"
    shift 2
  else
    shift
  fi
done
version="$(tr -d '\\n' < "$root/version.txt")"
printf 'deploy:%s\\n' "$version" >> "$FAKE_DEPLOY_LOG"
exit 0
""",
        encoding="utf-8",
    )
    executable.chmod(0o755)
    return executable


class UpdateStateConcurrencyTests(unittest.TestCase):
    def test_source_bridge_handoff_is_nonblocking_and_records_installer_results(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            _mark_updating(data_dir, "update-1")

            ready = mark_source_bridge_ready(data_dir, update_id="update-1")
            self.assertEqual(ready["state"], "waiting_for_tasks")
            self.assertEqual(ready["phase"], "source_bridge_ready")
            with self.assertRaisesRegex(RuntimeError, "no longer active"):
                heartbeat(data_dir, update_id="update-1")

            queued = mark_container_migration_result(
                data_dir,
                update_id="update-1",
                outcome="container_migration_queued",
            )
            self.assertEqual(queued["state"], "idle")
            self.assertEqual(queued["phase"], "container_migration_queued")
            self.assertNotIn("error", queued)

    def test_container_migration_failure_keeps_healthy_source_nonblocking(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            _mark_updating(data_dir, "update-1")
            mark_source_bridge_ready(data_dir, update_id="update-1")

            failed = mark_container_migration_result(
                data_dir,
                update_id="update-1",
                outcome="container_migration_failed",
                error="installer exited 69",
            )

            self.assertEqual(failed["state"], "idle")
            self.assertEqual(failed["phase"], "container_migration_failed")
            self.assertEqual(failed["error"], "installer exited 69")
            with self.assertRaisesRegex(ValueError, "invalid container migration result"):
                mark_container_migration_result(
                    data_dir,
                    update_id="update-1",
                    outcome="success",
                )

    def test_queued_migration_can_only_converge_to_failed(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            _mark_updating(data_dir, "update-1")
            mark_source_bridge_ready(data_dir, update_id="update-1")
            mark_container_migration_result(
                data_dir,
                update_id="update-1",
                outcome="container_migration_queued",
            )

            failed = mark_container_migration_result(
                data_dir,
                update_id="update-1",
                outcome="container_migration_failed",
                error="retry exited 69",
            )
            self.assertEqual(failed["phase"], "container_migration_failed")
            with self.assertRaisesRegex(RuntimeError, "explicit repair"):
                mark_container_migration_result(
                    data_dir,
                    update_id="update-1",
                    outcome="container_migration_queued",
                )

    def test_handoff_phases_freeze_generic_update_takeover(self):
        for terminal in (None, "container_migration_queued", "container_migration_failed"):
            with self.subTest(terminal=terminal), tempfile.TemporaryDirectory() as td:
                data_dir = Path(td)
                _mark_updating(data_dir, "update-1")
                mark_source_bridge_ready(data_dir, update_id="update-1")
                if terminal:
                    mark_container_migration_result(
                        data_dir,
                        update_id="update-1",
                        outcome=terminal,
                    )
                with self.assertRaisesRegex(RuntimeError, "migration|bridge"):
                    mark_updating(
                        data_dir,
                        update_id="update-2",
                        instance_id="instance-2",
                        reason="manual",
                        target_revision="b" * 40,
                        remote="origin",
                        branch="main",
                        takeover=True,
                    )

    def test_bridge_environment_repairs_old_generic_success_command(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            _mark_updating(data_dir, "update-1")
            with mock.patch.dict(
                os.environ,
                {
                    "ENTERPRISE_PLATFORM_DATA": str(data_dir),
                    "ENTERPRISE_AUTO_UPDATE_ID": "update-1",
                    "ENTERPRISE_AUTO_UPDATE_TARGET_REVISION": SOURCE_REVISION,
                    "UBITECH_SOURCE_MIGRATION_BRIDGE": "1",
                },
                clear=False,
            ):
                update_state_main(["success", "--outcome", "success"])
            state = read_state(data_dir)
            actual_revision = subprocess.check_output(
                ["git", "-C", str(Path(__file__).resolve().parents[2]), "rev-parse", "HEAD"],
                text=True,
            ).strip()
            self.assertEqual(state["state"], "waiting_for_tasks")
            self.assertEqual(state["phase"], "source_bridge_ready")
            self.assertEqual(state["source_revision"], actual_revision)
            self.assertNotEqual(state["source_revision"], SOURCE_REVISION)

    def test_bridge_ready_treats_post_replace_chmod_error_as_committed(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            _mark_updating(data_dir, "update-1")
            with mock.patch.object(
                update_state_module.os,
                "chmod",
                side_effect=OSError(5, "after replace"),
            ):
                ready = mark_source_bridge_ready(
                    data_dir,
                    update_id="update-1",
                    source_revision=SOURCE_REVISION,
                )
            self.assertEqual(ready["phase"], "source_bridge_ready")
            self.assertEqual(read_state(data_dir)["source_revision"], SOURCE_REVISION)

    def test_failed_container_migration_requires_locked_explicit_repair(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            _mark_updating(data_dir, "update-1")
            mark_source_bridge_ready(
                data_dir,
                update_id="update-1",
                source_revision=SOURCE_REVISION,
            )
            mark_container_migration_result(
                data_dir,
                update_id="update-1",
                outcome="container_migration_failed",
                error="docker unavailable",
            )
            with self.assertRaisesRegex(RuntimeError, "repository update lock"):
                recover_source_bridge_handoff(
                    data_dir,
                    update_id="update-1",
                    source_revision=SOURCE_REVISION,
                    repair_failed=True,
                )

            lock_path = data_dir / "repo.lock"
            descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX)
                with mock.patch.dict(
                    os.environ,
                    {
                        "ENTERPRISE_AUTO_UPDATE_LOCK_FD": str(descriptor),
                        "ENTERPRISE_AUTO_UPDATE_LOCK_PATH": str(lock_path),
                    },
                    clear=False,
                ):
                    with self.assertRaisesRegex(RuntimeError, "different update"):
                        recover_source_bridge_handoff(
                            data_dir,
                            update_id="update-2",
                            source_revision=SOURCE_REVISION,
                            repair_failed=True,
                        )
                    repaired = recover_source_bridge_handoff(
                        data_dir,
                        update_id="update-1",
                        source_revision=SOURCE_REVISION,
                        repair_failed=True,
                    )
            finally:
                os.close(descriptor)
            self.assertEqual(repaired["state"], "waiting_for_tasks")
            self.assertEqual(repaired["phase"], "source_bridge_ready")
            self.assertNotIn("error", repaired)

    def test_late_source_failure_cannot_replace_ready_handoff(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            _mark_updating(data_dir, "update-1")
            mark_source_bridge_ready(data_dir, update_id="update-1")
            with self.assertRaisesRegex(RuntimeError, "handoff"):
                mark_failure(data_dir, update_id="update-1", error="late")
            self.assertEqual(read_state(data_dir)["phase"], "source_bridge_ready")

    def test_heartbeat_worker_drops_inherited_repository_lock_descriptor(self):
        with tempfile.TemporaryDirectory() as td:
            repo_lock = Path(td) / "ubitech-agent-update.lock"
            fd = os.open(repo_lock, os.O_RDWR | os.O_CREAT, 0o600)
            try:
                with mock.patch.dict(
                    os.environ,
                    {
                        "ENTERPRISE_AUTO_UPDATE_LOCK_FD": str(fd),
                        "ENTERPRISE_AUTO_UPDATE_LOCK_PATH": str(repo_lock),
                    },
                    clear=False,
                ):
                    update_state_module._close_inherited_update_lock()
                    with self.assertRaises(OSError):
                        os.fstat(fd)
                    self.assertNotIn("ENTERPRISE_AUTO_UPDATE_LOCK_FD", os.environ)
                    self.assertNotIn("ENTERPRISE_AUTO_UPDATE_LOCK_PATH", os.environ)
            finally:
                try:
                    os.close(fd)
                except OSError:
                    pass

    def test_terminal_state_cannot_be_resurrected_by_heartbeat_or_same_id_begin(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            _mark_updating(data_dir, "update-1")
            mark_success(data_dir, update_id="update-1")

            with self.assertRaisesRegex(RuntimeError, "no longer active"):
                heartbeat(data_dir, update_id="update-1")
            with self.assertRaisesRegex(RuntimeError, "terminal"):
                mark_updating(
                    data_dir,
                    update_id="update-1",
                    instance_id="instance-2",
                    reason="retry",
                    target_revision="def456",
                    remote="origin",
                    branch="main",
                    takeover=True,
                )
            # A late failure from the same worker cannot replace success.
            mark_failure(data_dir, update_id="update-1", error="late")
            self.assertEqual(read_state(data_dir)["state"], "idle")

    def test_failed_state_rejects_heartbeat_but_allows_explicit_recovery(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            _mark_updating(data_dir, "update-1")
            mark_failure(data_dir, update_id="update-1", error="deployment failed")

            with self.assertRaisesRegex(RuntimeError, "no longer active"):
                heartbeat(data_dir, update_id="update-1")
            self.assertEqual(read_state(data_dir)["state"], "failed")
            mark_success(data_dir, update_id="update-1", outcome="operator_recovered")
            self.assertEqual(read_state(data_dir)["state"], "idle")

    def test_success_waits_for_inflight_heartbeat_and_wins_terminal_transition(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            _mark_updating(data_dir, "update-1")
            heartbeat_entered = threading.Event()
            allow_heartbeat_write = threading.Event()
            success_done = threading.Event()
            original_write = update_state_module._write_state

            def delayed_write(target, value):
                if (
                    threading.current_thread().name == "delayed-heartbeat"
                    and value.get("state") == "updating"
                ):
                    heartbeat_entered.set()
                    allow_heartbeat_write.wait(timeout=5)
                return original_write(target, value)

            def run_heartbeat() -> None:
                heartbeat(data_dir, update_id="update-1", phase="deploying")

            def run_success() -> None:
                mark_success(data_dir, update_id="update-1")
                success_done.set()

            with mock.patch.object(update_state_module, "_write_state", side_effect=delayed_write):
                beat_thread = threading.Thread(target=run_heartbeat, name="delayed-heartbeat")
                success_thread = threading.Thread(target=run_success, name="terminal-success")
                beat_thread.start()
                self.assertTrue(heartbeat_entered.wait(timeout=2))
                success_thread.start()
                time.sleep(0.05)
                self.assertFalse(success_done.is_set())
                allow_heartbeat_write.set()
                beat_thread.join(timeout=2)
                success_thread.join(timeout=2)

            self.assertFalse(beat_thread.is_alive())
            self.assertFalse(success_thread.is_alive())
            self.assertEqual(read_state(data_dir)["state"], "idle")

    def test_public_state_lock_serializes_external_admission_transaction(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            completed = threading.Event()

            def mutate() -> None:
                _mark_updating(data_dir, "update-1")
                completed.set()

            with update_state_lock(data_dir):
                thread = threading.Thread(target=mutate)
                thread.start()
                time.sleep(0.05)
                self.assertFalse(completed.is_set())
            thread.join(timeout=2)

            self.assertTrue(completed.is_set())
            self.assertEqual(state_lock_path(data_dir).stat().st_mode & 0o777, 0o600)

    def test_cross_update_takeover_requires_inherited_repository_lock(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td) / "data"
            _mark_updating(data_dir, "old-update")
            environment = {
                "ENTERPRISE_PLATFORM_DATA": str(data_dir),
                "ENTERPRISE_AUTO_UPDATE_ID": "new-update",
                "ENTERPRISE_AUTO_UPDATE_INSTANCE_ID": "instance-2",
            }
            with mock.patch.dict(os.environ, environment, clear=False):
                os.environ.pop("ENTERPRISE_AUTO_UPDATE_LOCK_FD", None)
                os.environ.pop("ENTERPRISE_AUTO_UPDATE_LOCK_PATH", None)
                with self.assertRaisesRegex(RuntimeError, "repository update lock"):
                    update_state_main(["begin", "--takeover"])

            repo_lock = Path(td) / "ubitech-agent-update.lock"
            fd = os.open(repo_lock, os.O_RDWR | os.O_CREAT, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with mock.patch.dict(
                    os.environ,
                    {
                        **environment,
                        "ENTERPRISE_AUTO_UPDATE_LOCK_FD": str(fd),
                        "ENTERPRISE_AUTO_UPDATE_LOCK_PATH": str(repo_lock),
                    },
                    clear=False,
                ):
                    update_state_main(["begin", "--phase", "pulling", "--takeover"])
            finally:
                os.close(fd)

            current = read_state(data_dir)
            self.assertEqual(current["state"], "updating")
            self.assertEqual(current["update_id"], "new-update")


class DeployStateProtocolTests(unittest.TestCase):
    def setUp(self):
        if not shutil.which("git") or not shutil.which("flock"):
            self.skipTest("git and flock are required")
        self.deploy_script = Path(__file__).resolve().parents[2] / "deploy.sh"

    def test_first_rollout_does_not_enable_state_protocol_after_source_move(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            checkout, _, new_sha = _init_update_checkout(
                base,
                self.deploy_script,
                old_has_state_helper=False,
                new_has_state_helper=True,
            )
            fake_python = _fake_deploy_python(base)
            log = base / "deploy.log"
            env = os.environ.copy()
            env.update(
                {
                    "PYTHON_BIN": str(fake_python),
                    "FAKE_DEPLOY_LOG": str(log),
                    "FAKE_REJECT_STATE_PROTOCOL": "1",
                }
            )

            result = subprocess.run(
                ["bash", str(checkout / "deploy.sh"), "update"],
                cwd=checkout,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=checkout, text=True).strip(),
                new_sha,
            )
            self.assertEqual(
                log.read_text(encoding="utf-8").splitlines(),
                ["docs:check", "docs:check-change", "deploy:new"],
            )

    def test_state_failure_after_source_move_rolls_back_before_exit(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            checkout, old_sha, _ = _init_update_checkout(
                base,
                self.deploy_script,
                old_has_state_helper=True,
                new_has_state_helper=True,
            )
            fake_python = _fake_deploy_python(base)
            log = base / "deploy.log"
            env = os.environ.copy()
            env.update(
                {
                    "PYTHON_BIN": str(fake_python),
                    "FAKE_DEPLOY_LOG": str(log),
                    "FAKE_FAIL_HEARTBEAT": "1",
                    "ENTERPRISE_PLATFORM_DATA": str(base / "data"),
                }
            )

            result = subprocess.run(
                ["bash", str(checkout / "deploy.sh"), "update"],
                cwd=checkout,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("rolling back", result.stderr.lower())
            self.assertEqual(
                subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=checkout, text=True).strip(),
                old_sha,
            )
            self.assertIn("deploy:old", log.read_text(encoding="utf-8").splitlines())

    def test_state_helper_removed_by_target_revision_forces_rollback(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            checkout, old_sha, _ = _init_update_checkout(
                base,
                self.deploy_script,
                old_has_state_helper=True,
                new_has_state_helper=False,
            )
            fake_python = _fake_deploy_python(base)
            log = base / "deploy.log"
            env = os.environ.copy()
            env.update(
                {
                    "PYTHON_BIN": str(fake_python),
                    "FAKE_DEPLOY_LOG": str(log),
                    "ENTERPRISE_PLATFORM_DATA": str(base / "data"),
                }
            )

            result = subprocess.run(
                ["bash", str(checkout / "deploy.sh"), "update"],
                cwd=checkout,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("state helper disappeared", result.stderr.lower())
            self.assertEqual(
                subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=checkout, text=True).strip(),
                old_sha,
            )
            self.assertIn("deploy:old", log.read_text(encoding="utf-8").splitlines())


if __name__ == "__main__":
    unittest.main()
