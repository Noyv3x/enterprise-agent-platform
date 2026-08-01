from __future__ import annotations

import base64
import copy
import datetime as dt
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "scripts"))

import release_promotion as promotion  # noqa: E402


SOURCE_PREDECESSOR = "1" * 40
A2 = "2" * 40
BRIDGE = "3" * 40
CLEANUP = "4" * 40
MANAGER_SHA = "a" * 64


class ReleasePromotionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.challenge_schema = REPOSITORY_ROOT / "docs/contracts/release-transition-challenge.schema.json"
        self.receipt_schema = REPOSITORY_ROOT / "docs/contracts/release-transition-receipt.schema.json"
        self.base_contract = json.loads(
            (REPOSITORY_ROOT / "docs/contracts/release-transition.json").read_text(
                encoding="utf-8"
            )
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_cleanup_directly_follows_stabilized_bridge(self) -> None:
        self.assertEqual(self.base_contract["stage"], "cleanup")
        self.assertEqual(
            self.base_contract["predecessor_generation"],
            "3a6dd8c0107cec7f6cf8d1b8805b687fc1f3f1a3",
        )

    @staticmethod
    def manifest(generation: str, schema_version: int = 1) -> dict[str, object]:
        managed = (
            promotion.MANAGED_IMAGES_V1
            if schema_version == 1
            else promotion.MANAGED_IMAGES_V2
        )
        return {
            "schema_version": schema_version,
            "channel": "main",
            "source_commit": generation,
            "generated_at": "2026-01-01T00:00:00Z",
            "protocol_version": schema_version,
            "database_schema_version": 1,
            "manager": {
                "version": generation,
                "artifacts": {
                    "amd64": {
                        "url": "https://example.invalid/manager-amd64",
                        "sha256": MANAGER_SHA,
                    },
                    "arm64": {
                        "url": "https://example.invalid/manager-arm64",
                        "sha256": "b" * 64,
                    },
                },
            },
            "compose": {
                "url": "https://example.invalid/compose.yaml",
                "sha256": "c" * 64,
            },
            "images": {
                name: f"ghcr.io/example/{name}@sha256:{index:064x}"
                for index, name in enumerate(sorted(managed), 1)
            },
        }

    def write_release(
        self,
        root: Path,
        *,
        stage: str,
        generation: str,
        predecessor: str,
        draft: bool,
    ) -> dict[str, object]:
        root.mkdir(parents=True, exist_ok=True)
        contract = copy.deepcopy(self.base_contract)
        contract["stage"] = stage
        contract["predecessor_generation"] = predecessor
        schema_version = 2 if stage in {"cleanup", "target_baseline"} else 1
        manifest = self.manifest(generation, schema_version)
        if stage == "bridge":
            predecessor_manifest = self.manifest(predecessor)
            manifest["namespace_handoff"] = {
                "schema_version": 1,
                "predecessor_generation": predecessor,
                "bridge_generation": generation,
                "source": {
                    "profile_id": self.base_contract["source_profile_id"],
                    "manager": predecessor_manifest["manager"],
                    "compose": predecessor_manifest["compose"],
                },
                "target": {
                    "profile_id": self.base_contract["target_profile_id"],
                    "manager": manifest["manager"],
                    "compose": manifest["compose"],
                },
            }
        paths = {
            "release-transition.json": contract,
            "release.json": manifest,
            "release-transition-challenge.schema.json": json.loads(
                self.challenge_schema.read_text(encoding="utf-8")
            ),
            "release-transition-receipt.schema.json": json.loads(
                self.receipt_schema.read_text(encoding="utf-8")
            ),
            "metadata.json": {
                "tag_name": f"container-{generation}",
                "draft": draft,
                "target_commitish": generation,
            },
        }
        for name, value in paths.items():
            (root / name).write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
        for name in promotion._release_assets(stage):
            path = root / name
            if name != "release.json":
                path.write_bytes(f"sealed fixture for {name}\n".encode("utf-8"))
        record = promotion.build_promotion(
            root / "release-transition.json",
            root / "release.json",
            root / "release-transition-challenge.schema.json",
            root / "release-transition-receipt.schema.json",
            generation,
            root,
        )
        (root / "promotion.json").write_text(
            json.dumps(record, indent=2) + "\n", encoding="utf-8"
        )
        return record

    def write_historical_current(
        self, root: Path, *, generation: str, predecessor: str
    ) -> dict[str, object]:
        """Write an already-sealed current release with an opaque retired contract."""

        root.mkdir(parents=True, exist_ok=True)
        contract = {"retired_contract": True, "opaque_historical_bytes": True}
        paths = {
            "release-transition.json": contract,
            "release.json": self.manifest(generation),
            "release-transition-challenge.schema.json": json.loads(
                self.challenge_schema.read_text(encoding="utf-8")
            ),
            "release-transition-receipt.schema.json": json.loads(
                self.receipt_schema.read_text(encoding="utf-8")
            ),
            "metadata.json": {
                "tag_name": f"container-{generation}",
                "draft": False,
                "target_commitish": generation,
            },
        }
        for name, value in paths.items():
            (root / name).write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
        for name in promotion.BRIDGE_SEALED_RELEASE_ASSETS:
            path = root / name
            if name != "release.json":
                path.write_bytes(f"sealed historical fixture for {name}\n".encode("utf-8"))
        record = {
            "schema_version": 1,
            "transition_id": self.base_contract["transition_id"],
            "stage": "source_owner",
            "generation": generation,
            "predecessor_generation": predecessor,
            "source_profile_id": self.base_contract["source_profile_id"],
            "target_profile_id": self.base_contract["target_profile_id"],
            "manifest_schema_version": 1,
            "manifest_sha256": promotion._sha256(root / "release.json"),
            "contract_sha256": promotion._sha256(root / "release-transition.json"),
            "challenge_schema_sha256": promotion._sha256(
                root / "release-transition-challenge.schema.json"
            ),
            "receipt_schema_sha256": promotion._sha256(
                root / "release-transition-receipt.schema.json"
            ),
            "required_receipt_type": None,
            "sealed_assets": promotion._sealed_assets(root, "source_owner"),
        }
        (root / "promotion.json").write_text(
            json.dumps(record, indent=2) + "\n", encoding="utf-8"
        )
        return record

    def test_promotion_seals_exact_non_self_release_asset_directory(self) -> None:
        root = self.root / A2
        record = self.write_release(
            root,
            stage="bridge",
            generation=A2,
            predecessor=SOURCE_PREDECESSOR,
            draft=True,
        )
        self.assertEqual(
            [asset["name"] for asset in record["sealed_assets"]],
            list(promotion.BRIDGE_SEALED_RELEASE_ASSETS),
        )
        self.assertNotIn("promotion.json", promotion.BRIDGE_SEALED_RELEASE_ASSETS)

        def validate(*, with_assets: bool = True) -> None:
            promotion.validate_promotion(
                root / "promotion.json",
                root / "release-transition.json",
                root / "release.json",
                root / "release-transition-challenge.schema.json",
                root / "release-transition-receipt.schema.json",
                A2,
                root if with_assets else None,
            )

        validate()
        install = root / "install.sh"
        install.write_bytes(install.read_bytes() + b"drift\n")
        with self.assertRaisesRegex(promotion.PromotionError, "immutable contract and release assets"):
            validate()

        self.write_release(
            root,
            stage="bridge",
            generation=A2,
            predecessor=SOURCE_PREDECESSOR,
            draft=True,
        )
        changed = json.loads((root / "promotion.json").read_text(encoding="utf-8"))
        changed["sealed_assets"].append(
            {"name": "unknown", "sha256": "f" * 64, "size": 1}
        )
        (root / "promotion.json").write_text(json.dumps(changed), encoding="utf-8")
        with self.assertRaisesRegex(promotion.PromotionError, "exact closed release shape"):
            validate(with_assets=False)

        changed["sealed_assets"] = list(record["sealed_assets"])
        changed["sealed_assets"][1] = dict(changed["sealed_assets"][0])
        (root / "promotion.json").write_text(json.dumps(changed), encoding="utf-8")
        with self.assertRaisesRegex(promotion.PromotionError, "unique and sorted"):
            validate(with_assets=False)

    def test_target_only_seal_uses_only_neutral_asset_names(self) -> None:
        root = self.root / CLEANUP
        record = self.write_release(
            root,
            stage="cleanup",
            generation=CLEANUP,
            predecessor=BRIDGE,
            draft=True,
        )
        names = [asset["name"] for asset in record["sealed_assets"]]
        self.assertEqual(names, list(promotion.TARGET_SEALED_RELEASE_ASSETS))
        self.assertIn("agent-platform-compose.yaml", names)
        self.assertFalse(any("ubitech" in name for name in names))

        source_identity = self.release_identity(CLEANUP, "bridge")
        with self.assertRaisesRegex(promotion.PromotionError, "unknown name"):
            promotion.validate_release_identity(
                source_identity, CLEANUP, "cleanup"
            )

    @staticmethod
    def release_identity(
        generation: str, stage: str = "bridge"
    ) -> dict[str, object]:
        return {
            "release_id": 4001,
            "tag_name": f"container-{generation}",
            "target_commitish": generation,
            "draft": True,
            "prerelease": False,
            "assets": [
                {
                    "id": 5000 + index,
                    "name": name,
                    "digest": "sha256:" + f"{index + 1:064x}",
                    "size": index + 1,
                    "state": "uploaded",
                }
                for index, name in enumerate(promotion._all_release_assets(stage))
            ],
        }

    @staticmethod
    def source_selection(
        event: str,
        source_commit: str,
        *,
        requested_ref: str | None = None,
    ) -> dict[str, object]:
        return {
            "kind": event,
            "resolution": promotion.SOURCE_SELECTION_RESOLUTION[event],
            "requested_ref": requested_ref,
            "qualification_run_id": 9001,
            "qualification_run_attempt": 3,
            "qualification_workflow_path": ".github/workflows/quality.yml",
            "qualification_event": "push",
            "qualification_conclusion": "success",
            "qualification_head_branch": "main",
            "qualification_head_sha": source_commit,
            "qualification_head_repository": "example/agent-platform",
        }

    def test_publisher_provenance_binds_exact_run_attempt_and_release_identity(self) -> None:
        identity = self.release_identity(A2)
        selection = self.source_selection("workflow_run", A2)
        proof = promotion.build_publisher_provenance(
            "example/agent-platform",
            "workflow_run",
            12345,
            2,
            BRIDGE,
            A2,
            selection,
            identity,
            "bridge",
        )
        self.assertEqual(proof["workflow_path"], promotion.PUBLISHER_WORKFLOW_PATH)
        self.assertEqual(proof["execution_head_sha"], BRIDGE)
        self.assertEqual(proof["source_commit"], A2)
        self.assertEqual(proof["release"], identity)
        self.assertEqual(
            promotion.validate_publisher_provenance(
                proof,
                "example/agent-platform",
                "workflow_run",
                12345,
                2,
                BRIDGE,
                A2,
                selection,
                identity,
                "bridge",
            ),
            proof,
        )

        changed_cases: list[tuple[str, object]] = [
            ("repository", "attacker/agent-platform"),
            ("workflow_event", "workflow_dispatch"),
            ("workflow_run_id", 12346),
            ("run_attempt", 3),
            ("execution_head_sha", CLEANUP),
            ("source_commit", BRIDGE),
        ]
        for field, value in changed_cases:
            kwargs = {
                "repository": "example/agent-platform",
                "workflow_event": "workflow_run",
                "workflow_run_id": 12345,
                "run_attempt": 2,
                "execution_head_sha": BRIDGE,
                "source_commit": A2,
                "source_selection": selection,
                "release_identity": identity,
                "candidate_stage": "bridge",
            }
            kwargs[field] = value
            with self.subTest(field=field), self.assertRaises(promotion.PromotionError):
                promotion.validate_publisher_provenance(proof, **kwargs)

        mutations = []
        for field, value in (
            ("release_id", 4002),
            ("draft", False),
        ):
            changed = copy.deepcopy(identity)
            changed[field] = value
            mutations.append((field, changed))
        for field, value in (
            ("id", 9999),
            ("digest", "sha256:" + "f" * 64),
            ("size", 9999),
            ("state", "new"),
            ("name", "unknown"),
        ):
            changed = copy.deepcopy(identity)
            changed["assets"][0][field] = value
            mutations.append((f"asset.{field}", changed))
        changed = copy.deepcopy(identity)
        changed["unexpected"] = True
        mutations.append(("unexpected", changed))
        for field, changed in mutations:
            with self.subTest(field=field), self.assertRaises(promotion.PromotionError):
                promotion.validate_publisher_provenance(
                    proof,
                    "example/agent-platform",
                    "workflow_run",
                    12345,
                    2,
                    BRIDGE,
                    A2,
                    selection,
                    changed,
                    "bridge",
                )

        mismatched_selection = copy.deepcopy(selection)
        mismatched_selection["qualification_head_sha"] = BRIDGE
        with self.assertRaisesRegex(
            promotion.PromotionError, "does not prove the released source commit"
        ):
            promotion.build_publisher_provenance(
                "example/agent-platform",
                "workflow_run",
                12345,
                2,
                BRIDGE,
                A2,
                mismatched_selection,
                identity,
                "bridge",
            )

        changed_proof = copy.deepcopy(proof)
        changed_proof["run_attempt"] = 3
        with self.assertRaisesRegex(
            promotion.PromotionError, "does not match the successful release attempt"
        ):
            promotion.validate_publisher_provenance(
                changed_proof,
                "example/agent-platform",
                "workflow_run",
                12345,
                2,
                BRIDGE,
                A2,
                selection,
                identity,
                "bridge",
            )

    def test_publisher_provenance_rejects_retired_bridge_qualification_field(self) -> None:
        bridge_identity = self.release_identity(A2, "bridge")
        bridge_selection = self.source_selection("workflow_run", A2)
        bridge = promotion.build_publisher_provenance(
            "example/agent-platform",
            "workflow_run",
            12345,
            2,
            BRIDGE,
            A2,
            bridge_selection,
            bridge_identity,
            "bridge",
        )
        self.assertNotIn("bridge_qualification", bridge)
        retired = copy.deepcopy(bridge)
        retired["bridge_qualification"] = {"harness_sha256": "6" * 64}
        with self.assertRaisesRegex(promotion.PromotionError, "exact closed shape"):
            promotion.validate_publisher_provenance(
                retired,
                "example/agent-platform",
                "workflow_run",
                12345,
                2,
                BRIDGE,
                A2,
                bridge_selection,
                bridge_identity,
                "bridge",
            )

        identity = self.release_identity(CLEANUP, "target_baseline")
        selection = self.source_selection("workflow_run", CLEANUP)
        ordinary = promotion.build_publisher_provenance(
            "example/agent-platform",
            "workflow_run",
            12345,
            2,
            BRIDGE,
            CLEANUP,
            selection,
            identity,
            "target_baseline",
        )
        self.assertNotIn("bridge_qualification", ordinary)

    def test_publisher_provenance_cli_round_trip_is_retry_safe(self) -> None:
        identity = self.release_identity(A2)
        identity_path = self.root / "release-identity.json"
        selection_path = self.root / "source-selection.json"
        proof_path = self.root / "publisher-provenance.json"
        identity_path.write_text(json.dumps(identity), encoding="utf-8")
        selection_path.write_text(
            json.dumps(
                self.source_selection(
                    "workflow_dispatch", A2, requested_ref="refs/heads/main"
                )
            ),
            encoding="utf-8",
        )
        common = [
            "--repository", "example/agent-platform",
            "--workflow-event", "workflow_dispatch",
            "--workflow-run-id", "67890",
            "--run-attempt", "4",
            "--execution-head-sha", CLEANUP,
            "--source-commit", A2,
            "--source-selection", str(selection_path),
            "--release-identity", str(identity_path),
            "--candidate-stage", "bridge",
        ]
        self.assertEqual(
            promotion.main(["create-publisher-provenance", *common, "--output", str(proof_path)]),
            0,
        )
        before = identity_path.read_bytes()
        self.assertEqual(
            promotion.main(
                ["validate-publisher-provenance", *common, "--provenance", str(proof_path)]
            ),
            0,
        )
        self.assertEqual(identity_path.read_bytes(), before)

    def test_selector_cannot_skip_or_reorder_transition_stages(self) -> None:
        candidates = self.root / "candidates"
        a2_root = candidates / A2
        bridge_root = candidates / BRIDGE
        cleanup_root = candidates / CLEANUP
        self.write_historical_current(
            a2_root,
            generation=A2,
            predecessor=SOURCE_PREDECESSOR,
        )
        self.write_release(
            bridge_root,
            stage="bridge",
            generation=BRIDGE,
            predecessor=A2,
            draft=True,
        )
        self.write_release(
            cleanup_root,
            stage="cleanup",
            generation=CLEANUP,
            predecessor=BRIDGE,
            draft=True,
        )

        first = promotion.select_candidate(A2, candidates, a2_root)
        self.assertEqual(first["candidate"]["generation"], BRIDGE)
        second = promotion.select_candidate(BRIDGE, candidates, bridge_root)
        self.assertEqual(second["candidate"]["generation"], CLEANUP)
        self.assertEqual(
            promotion.select_candidate(CLEANUP, candidates, cleanup_root),
            {"action": "none"},
        )

        # A cleanup release that lies about its predecessor cannot become
        # latest even when it has a newer generation id.
        contract_path = cleanup_root / "release-transition.json"
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
        contract["predecessor_generation"] = A2
        contract_path.write_text(json.dumps(contract), encoding="utf-8")
        record = promotion.build_promotion(
            contract_path,
            cleanup_root / "release.json",
            cleanup_root / "release-transition-challenge.schema.json",
            cleanup_root / "release-transition-receipt.schema.json",
            CLEANUP,
            cleanup_root,
        )
        (cleanup_root / "promotion.json").write_text(json.dumps(record), encoding="utf-8")
        with self.assertRaisesRegex(promotion.PromotionError, "does not directly follow"):
            promotion.select_candidate(A2, candidates, a2_root)

    def test_historical_source_owner_current_uses_only_its_byte_seal(self) -> None:
        candidates = self.root / "historical-current"
        current = candidates / A2
        bridge = candidates / BRIDGE
        self.write_historical_current(
            current,
            generation=A2,
            predecessor=SOURCE_PREDECESSOR,
        )
        self.write_release(
            bridge,
            stage="bridge",
            generation=BRIDGE,
            predecessor=A2,
            draft=True,
        )
        self.write_release(
            candidates / CLEANUP,
            stage="cleanup",
            generation=CLEANUP,
            predecessor=BRIDGE,
            draft=True,
        )
        self.assertEqual(
            promotion.select_candidate(A2, candidates, current)["candidate"]["generation"],
            BRIDGE,
        )
        contract = current / "release-transition.json"
        contract.write_bytes(contract.read_bytes() + b" ")
        with self.assertRaisesRegex(promotion.PromotionError, "contract_sha256"):
            promotion.select_candidate(A2, candidates, current)

        self.write_historical_current(
            current,
            generation=A2,
            predecessor=SOURCE_PREDECESSOR,
        )
        install = current / "install.sh"
        install.write_bytes(install.read_bytes() + b"drift\n")
        with self.assertRaisesRegex(promotion.PromotionError, "sealed asset directory"):
            promotion.select_candidate(A2, candidates, current)

    def test_selector_requires_sealed_current_and_rejects_public_candidate(self) -> None:
        candidates = self.root / "candidates"
        current_root = candidates / A2
        self.write_historical_current(
            current_root,
            generation=A2,
            predecessor=SOURCE_PREDECESSOR,
        )
        self.write_release(
            candidates / BRIDGE,
            stage="bridge",
            generation=BRIDGE,
            predecessor=A2,
            draft=False,
        )
        with self.assertRaisesRegex(promotion.PromotionError, "complete sealed promotion"):
            promotion.select_candidate(A2, candidates, None)
        with self.assertRaisesRegex(promotion.PromotionError, "is not draft"):
            promotion.select_candidate(A2, candidates, current_root)

    def test_bridge_cannot_be_selected_before_exact_cleanup_is_prebuilt(self) -> None:
        candidates = self.root / "prebuild-gate"
        current_root = candidates / A2
        self.write_historical_current(
            current_root,
            generation=A2,
            predecessor=SOURCE_PREDECESSOR,
        )
        self.write_release(
            candidates / BRIDGE,
            stage="bridge",
            generation=BRIDGE,
            predecessor=A2,
            draft=True,
        )
        waiting = promotion.select_candidate(A2, candidates, current_root)
        self.assertEqual(waiting["action"], "prepare_cleanup")
        self.assertEqual(waiting["candidate"]["generation"], BRIDGE)

        cleanup_root = candidates / CLEANUP
        self.write_release(
            cleanup_root,
            stage="cleanup",
            generation=CLEANUP,
            predecessor=BRIDGE,
            draft=True,
        )
        selected = promotion.select_candidate(A2, candidates, current_root)
        self.assertEqual(selected["prebuilt_cleanup_generation"], CLEANUP)

        metadata = json.loads(
            (cleanup_root / "metadata.json").read_text(encoding="utf-8")
        )
        metadata["draft"] = False
        (cleanup_root / "metadata.json").write_text(
            json.dumps(metadata), encoding="utf-8"
        )
        with self.assertRaisesRegex(promotion.PromotionError, "must remain draft"):
            promotion.select_candidate(A2, candidates, current_root)

    def test_cleanup_schema_v2_barrier_is_enforced_before_publication(self) -> None:
        root = self.root / CLEANUP
        self.write_release(
            root,
            stage="cleanup",
            generation=CLEANUP,
            predecessor=BRIDGE,
            draft=True,
        )
        manifest_path = root / "release.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["schema_version"] = 1
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(promotion.PromotionError, "schema-v2 barrier"):
            promotion.build_promotion(
                root / "release-transition.json",
                manifest_path,
                root / "release-transition-challenge.schema.json",
                root / "release-transition-receipt.schema.json",
                CLEANUP,
                root,
            )

    def test_bridge_source_artifacts_must_exactly_match_predecessor(self) -> None:
        candidates = self.root / "candidates"
        predecessor_root = candidates / A2
        bridge_root = candidates / BRIDGE
        self.write_historical_current(
            predecessor_root,
            generation=A2,
            predecessor=SOURCE_PREDECESSOR,
        )
        self.write_release(
            bridge_root,
            stage="bridge",
            generation=BRIDGE,
            predecessor=A2,
            draft=True,
        )
        self.write_release(
            candidates / CLEANUP,
            stage="cleanup",
            generation=CLEANUP,
            predecessor=BRIDGE,
            draft=True,
        )

        selected = promotion.select_candidate(A2, candidates, predecessor_root)
        self.assertEqual(selected["candidate"]["generation"], BRIDGE)

        for field in ("manager", "compose"):
            with self.subTest(field=field):
                manifest_path = bridge_root / "release.json"
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                source = manifest["namespace_handoff"]["source"]
                if field == "manager":
                    source[field]["artifacts"]["arm64"]["sha256"] = "e" * 64
                else:
                    source[field]["url"] = "https://example.invalid/not-the-predecessor.yaml"
                manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                record = promotion.build_promotion(
                    bridge_root / "release-transition.json",
                    manifest_path,
                    bridge_root / "release-transition-challenge.schema.json",
                    bridge_root / "release-transition-receipt.schema.json",
                    BRIDGE,
                    bridge_root,
                )
                (bridge_root / "promotion.json").write_text(
                    json.dumps(record), encoding="utf-8"
                )
                with self.assertRaisesRegex(
                    promotion.PromotionError,
                    rf"bridge source {field} must exactly match",
                ):
                    promotion.select_candidate(A2, candidates, predecessor_root)

                # Restore the immutable fixture before exercising the next
                # independent source binding.
                self.write_release(
                    bridge_root,
                    stage="bridge",
                    generation=BRIDGE,
                    predecessor=A2,
                    draft=True,
                )

    def test_cleanup_can_continue_only_as_target_baseline(self) -> None:
        candidates = self.root / "candidates"
        cleanup_root = candidates / CLEANUP
        target_d = "5" * 40
        target_e = "6" * 40

        self.write_release(
            cleanup_root,
            stage="cleanup",
            generation=CLEANUP,
            predecessor=BRIDGE,
            draft=False,
        )
        d_root = candidates / target_d
        d_record = self.write_release(
            d_root,
            stage="target_baseline",
            generation=target_d,
            predecessor=CLEANUP,
            draft=True,
        )
        self.assertIsNone(d_record["required_receipt_type"])
        selected_d = promotion.select_candidate(CLEANUP, candidates, cleanup_root)
        self.assertEqual(selected_d["candidate"]["generation"], target_d)

        e_root = candidates / target_e
        self.write_release(
            e_root,
            stage="target_baseline",
            generation=target_e,
            predecessor=target_d,
            draft=True,
        )
        selected_e = promotion.select_candidate(target_d, candidates, d_root)
        self.assertEqual(selected_e["candidate"]["generation"], target_e)

        # Ordinary target-only D/E releases are published directly, but the
        # immutable direct-predecessor chain is still mandatory.
        e_contract_path = e_root / "release-transition.json"
        e_contract = json.loads(e_contract_path.read_text(encoding="utf-8"))
        e_contract["predecessor_generation"] = CLEANUP
        e_contract_path.write_text(json.dumps(e_contract), encoding="utf-8")
        e_record = promotion.build_promotion(
            e_contract_path,
            e_root / "release.json",
            e_root / "release-transition-challenge.schema.json",
            e_root / "release-transition-receipt.schema.json",
            target_e,
            e_root,
        )
        (e_root / "promotion.json").write_text(json.dumps(e_record), encoding="utf-8")
        self.assertEqual(
            promotion.select_candidate(target_d, candidates, d_root),
            {"action": "none"},
        )

        # Restore E, then prove a target-only generation cannot smuggle the
        # one-time bridge descriptor back into the channel after cleanup.
        self.write_release(
            e_root,
            stage="target_baseline",
            generation=target_e,
            predecessor=target_d,
            draft=True,
        )
        manifest_path = e_root / "release.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["namespace_handoff"] = {"schema_version": 1}
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(
            promotion.PromotionError,
            "must not retain the one-time namespace_handoff descriptor",
        ):
            promotion.build_promotion(
                e_root / "release-transition.json",
                manifest_path,
                e_root / "release-transition-challenge.schema.json",
                e_root / "release-transition-receipt.schema.json",
                target_e,
                e_root,
            )

    def test_target_publication_predecessor_is_bound_at_seal_time(self) -> None:
        root = self.root / ("7" * 40)
        generation = root.name
        self.write_release(
            root,
            stage="target_baseline",
            generation=generation,
            predecessor=CLEANUP,
            draft=True,
        )
        dynamic_predecessor = "6" * 40
        record = promotion.build_promotion(
            root / "release-transition.json",
            root / "release.json",
            root / "release-transition-challenge.schema.json",
            root / "release-transition-receipt.schema.json",
            generation,
            root,
            dynamic_predecessor,
        )
        self.assertEqual(record["predecessor_generation"], dynamic_predecessor)
        (root / "promotion.json").write_text(json.dumps(record), encoding="utf-8")
        validated = promotion.validate_promotion(
            root / "promotion.json",
            root / "release-transition.json",
            root / "release.json",
            root / "release-transition-challenge.schema.json",
            root / "release-transition-receipt.schema.json",
            generation,
            root,
        )
        self.assertEqual(validated["predecessor_generation"], dynamic_predecessor)

    def test_target_publication_slot_rejects_second_sealed_direct_successor(self) -> None:
        slot = self.root / "target-slot"
        first = "7" * 40
        second = "8" * 40
        self.write_release(
            slot / first,
            stage="target_baseline",
            generation=first,
            predecessor=CLEANUP,
            draft=True,
        )
        promotion.ensure_publication_slot(CLEANUP, first, "target_baseline", slot)
        with self.assertRaisesRegex(promotion.PromotionError, "slot is occupied"):
            promotion.ensure_publication_slot(CLEANUP, second, "target_baseline", slot)

    def test_transition_publication_slot_also_rejects_duplicate_bridge_or_cleanup(self) -> None:
        for stage, predecessor in (("bridge", A2), ("cleanup", BRIDGE)):
            with self.subTest(stage=stage):
                slot = self.root / f"{stage}-slot"
                first = "9" * 40
                second = "a" * 40
                self.write_release(
                    slot / first,
                    stage=stage,
                    generation=first,
                    predecessor=predecessor,
                    draft=True,
                )
                with self.assertRaisesRegex(promotion.PromotionError, "slot is occupied"):
                    promotion.ensure_publication_slot(
                        predecessor, second, stage, slot
                    )

    def _signed_receipt_fixture(self) -> tuple[
        dict[str, object],
        dict[str, object],
        dict[str, object],
        dict[str, object],
        Path,
        str,
        dict[str, object],
        dict[str, object],
    ]:
        root = self.root / BRIDGE
        record = self.write_release(
            root,
            stage="bridge",
            generation=BRIDGE,
            predecessor=A2,
            draft=True,
        )
        contract = json.loads((root / "release-transition.json").read_text(encoding="utf-8"))
        challenge_schema = json.loads(
            (root / "release-transition-challenge.schema.json").read_text(encoding="utf-8")
        )
        receipt_schema = json.loads(
            (root / "release-transition-receipt.schema.json").read_text(encoding="utf-8")
        )
        now = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
        challenge = promotion.issue_challenge(
            record,
            contract,
            challenge_schema,
            "deployment-1",
            "primary",
            A2,
            now,
        )
        receipt = {
            "schema_version": 1,
            "transition_id": challenge["transition_id"],
            "challenge_id": challenge["challenge_id"],
            "nonce": challenge["nonce"],
            "receipt_type": challenge["receipt_type"],
            "deployment_id": challenge["deployment_id"],
            "key_id": challenge["key_id"],
            "predecessor_generation": challenge["predecessor_generation"],
            "candidate_generation": challenge["candidate_generation"],
            "observed_generation": challenge["expected_observed_generation"],
            "profile_id": challenge["expected_profile_id"],
            "capability": challenge["expected_capability"],
            "status": challenge["expected_status"],
            "architecture": "amd64",
            "manager_sha256": MANAGER_SHA,
            "evidence_sha256": "d" * 64,
            "issued_at": "2026-01-01T00:00:01Z",
            "expires_at": "2026-01-01T00:04:00Z",
        }
        private_key = self.root / "private.pem"
        public_key = self.root / "public.pem"
        subprocess.run(
            ["openssl", "genpkey", "-algorithm", "ED25519", "-out", private_key],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        subprocess.run(
            ["openssl", "pkey", "-in", private_key, "-pubout", "-out", public_key],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        signature = self.sign(private_key, receipt)
        return record, contract, challenge_schema, receipt_schema, public_key, signature, challenge, receipt

    def sign(self, private_key: Path, receipt: dict[str, object]) -> str:
        message = self.root / "receipt.jcs"
        signature = self.root / "receipt.bin"
        message.write_bytes(promotion.canonical_json(receipt))
        subprocess.run(
            [
                "openssl",
                "pkeyutl",
                "-sign",
                "-inkey",
                private_key,
                "-rawin",
                "-in",
                message,
                "-out",
                signature,
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        return base64.b64encode(signature.read_bytes()).decode("ascii")

    def test_ed25519_receipt_is_closed_bound_fresh_and_replay_safe(self) -> None:
        (
            record,
            contract,
            challenge_schema,
            receipt_schema,
            public_key,
            signature,
            challenge,
            receipt,
        ) = self._signed_receipt_fixture()
        predecessor = self.manifest(A2)
        now = dt.datetime(2026, 1, 1, 0, 2, tzinfo=dt.timezone.utc)
        verified = promotion.verify_receipt(
            record,
            contract,
            challenge_schema,
            receipt_schema,
            challenge,
            receipt,
            signature,
            public_key,
            "deployment-1",
            "primary",
            A2,
            predecessor,
            set(),
            now,
        )
        self.assertEqual(verified["challenge_id"], challenge["challenge_id"])

        with self.assertRaisesRegex(promotion.PromotionError, "already consumed"):
            promotion.verify_receipt(
                record,
                contract,
                challenge_schema,
                receipt_schema,
                challenge,
                receipt,
                signature,
                public_key,
                "deployment-1",
                "primary",
                A2,
                predecessor,
                {challenge["challenge_id"]},
                now,
            )

        for field, wrong in (
            ("deployment_id", "deployment-2"),
            ("profile_id", "agent-platform-v1"),
            ("observed_generation", SOURCE_PREDECESSOR),
            ("capability", "target_owner"),
            ("status", "committed"),
        ):
            changed = dict(receipt)
            changed[field] = wrong
            private_key = self.root / "private.pem"
            changed_signature = self.sign(private_key, changed)
            with self.subTest(field=field), self.assertRaises(promotion.PromotionError):
                promotion.verify_receipt(
                    record,
                    contract,
                    challenge_schema,
                    receipt_schema,
                    challenge,
                    changed,
                    changed_signature,
                    public_key,
                    "deployment-1",
                    "primary",
                    A2,
                    predecessor,
                    set(),
                    now,
                )

        with self.assertRaisesRegex(promotion.PromotionError, "not currently valid"):
            promotion.verify_receipt(
                record,
                contract,
                challenge_schema,
                receipt_schema,
                challenge,
                receipt,
                signature,
                public_key,
                "deployment-1",
                "primary",
                A2,
                predecessor,
                set(),
                dt.datetime(2026, 1, 1, 0, 6, tzinfo=dt.timezone.utc),
            )

        missing = dict(receipt)
        missing.pop("status")
        with self.assertRaisesRegex(promotion.PromotionError, "missing required keys"):
            promotion.verify_receipt(
                record,
                contract,
                challenge_schema,
                receipt_schema,
                challenge,
                missing,
                signature,
                public_key,
                "deployment-1",
                "primary",
                A2,
                predecessor,
                set(),
                now,
            )

    def test_only_serialized_evaluator_can_change_release_visibility(self) -> None:
        container = (REPOSITORY_ROOT / ".github/workflows/container-release.yml").read_text(
            encoding="utf-8"
        )
        evaluator = (REPOSITORY_ROOT / ".github/workflows/channel-promotion.yml").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("--draft=false", container)
        self.assertNotIn("--latest", container)
        self.assertNotIn("--clobber", container)
        self.assertIn('--assets-root "$stage"', container)
        self.assertIn("local release directory mismatch", container)
        self.assertIn("group: container-channel-main", evaluator)
        self.assertIn("select-candidate", evaluator)
        self.assertIn("release-transition-consumed-${challenge_id}", evaluator)
        self.assertIn("Prove the triggering release job actually published", evaluator)
        self.assertIn('.path == ".github/workflows/container-release.yml"', evaluator)
        self.assertIn('.name == "Publish atomic main release"', evaluator)
        self.assertIn("invalid paginated releases response", evaluator)
        self.assertIn("invalid paginated workflow jobs response", evaluator)
        self.assertIn("downloaded release directory mismatch", evaluator)
        self.assertIn("Current release is not a complete sealed generation", evaluator)
        self.assertNotIn("--current-compat-root", evaluator)
        self.assertNotIn("source_owner_compat", evaluator)
        self.assertEqual(
            evaluator.count("scripts/verify-release-images-anonymous.sh"), 4
        )
        self.assertEqual(
            evaluator.count("CRITICAL post-visibility registry failure"), 2
        )
        self.assertEqual(
            evaluator.count("scripts/ensure-release-candidate-tag.sh"), 2
        )
        self.assertIn("create-publisher-provenance", container)
        self.assertIn(".publisher-policy/scripts/release_promotion.py", container)
        self.assertIn("Upload immutable release provenance", container)
        self.assertIn("validate-publisher-provenance", evaluator)
        self.assertIn("candidate-publisher-runs.json", evaluator)
        self.assertIn("publisher provenance artifact must contain exactly", evaluator)
        self.assertIn("Triggering Container release run has no unique provenance", evaluator)
        self.assertIn("execution_head_sha", evaluator)
        self.assertIn("qualification_head_sha", evaluator)
        self.assertIn("Verify real Manager restart and watchdog cgroups", container)
        self.assertIn("Verify Bridge persistent helper cgroup", container)
        self.assertIn('AGENT_PLATFORM_SYSTEMD_INTEGRATION: "1"', container)
        self.assertIn("scripts/release_promotion.py verify-receipt", evaluator)
        self.assertIn("RELEASE_TRANSITION_ED25519_PUBLIC_KEY_PEM", evaluator)
        self.assertIn("--candidate-stage \"$CANDIDATE_STAGE\"", evaluator)
        for retired_bridge_qualification in (
            "release-transition-qualification.schema.json",
            "scripts/release_qualification.py",
            "Bridge qualification artifact",
            "--bridge-qualification",
            "provenance_harness_sha",
            "Predecessor crash qualification",
            "bridge-predecessor-qualification",
        ):
            self.assertNotIn(retired_bridge_qualification, evaluator)
        self.assertIn("agent-platform-compose.yaml", container)
        self.assertIn("agent-platform-manager-linux-amd64", container)
        self.assertIn("Cleanup must be prebuilt while its Bridge predecessor remains draft", container)
        self.assertIn("Cleanup predecessor has no exact successful sealed publisher provenance", container)
        self.assertEqual(
            container.count('elif [[ -n "$expected_id" ]]; then'), 1
        )
        self.assertIn("Expected pulled image ${reference} (${expected_id}) is already missing", container)
        self.assertIn("prebuilt_cleanup_generation", evaluator)
        self.assertIn("prebuilt Cleanup sealed asset drift", evaluator)
        self.assertIn("group: container-publish-main", container)
        self.assertIn("scripts/release_promotion.py ensure-publication-slot", container)
        self.assertIn('promotion_args+=(--predecessor-generation "$predecessor")', container)
        self.assertIn("action == 'prepare_cleanup'", evaluator)
        self.assertIn("Queue the canonical missing Cleanup release", evaluator)
        self.assertIn('gh workflow run container-release.yml', evaluator)
        self.assertIn("Queue the latest qualified target-only main generation", evaluator)
        self.assertIn("Continue the sealed transition chain", evaluator)
        self.assertIn("if: needs.prepare.outputs.transition_stage == 'bridge'", container)
        self.assertIn("./internal/handoffhost", container)
        self.assertIn("manager_command=./cmd/agent-platform-manager", container)
        self.assertIn('matrix: ${{ fromJSON(needs.prepare.outputs.image_matrix) }}', container)
        self.assertIn('[[ "$TRANSITION_STAGE" == bridge ]] && expected_images=11', container)
        self.assertIn("agent-platform-compose.yaml", evaluator)
        self.assertIn('cmp "$SEALED_IDENTITY" "$before"', evaluator)
        self.assertEqual(evaluator.count('cmp "$SEALED_IDENTITY" "$before"'), 2)
        self.assertEqual(evaluator.count("releases/latest"), 4)
        self.assertIn("REQUESTED_CANDIDATE: ${{ inputs.candidate_generation }}", evaluator)
        self.assertIn('requested="$REQUESTED_CANDIDATE"', evaluator)
        self.assertNotIn("requested='${{ inputs.candidate_generation }}'", evaluator)
        self.assertIn('[[ ! "$CHALLENGE_RUN_ID" =~ ^[1-9][0-9]{0,19}$ ]]', evaluator)
        normalized = " ".join(evaluator.split())
        ordinary = "steps.select.outputs.candidate_stage == 'target_baseline'"
        gated = (
            "(steps.select.outputs.candidate_stage == 'bridge' || "
            "steps.select.outputs.candidate_stage == 'cleanup')"
        )
        self.assertIn(ordinary, normalized)
        self.assertEqual(normalized.count(gated), 3)
        self.assertNotIn("candidate_stage == 'source_owner'", evaluator)
        for workflow in (REPOSITORY_ROOT / ".github/workflows").glob("*.yml"):
            if workflow.name == "channel-promotion.yml":
                continue
            self.assertNotIn("--draft=false", workflow.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
