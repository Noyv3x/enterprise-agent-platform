from __future__ import annotations

import base64
import copy
import datetime as dt
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "scripts"))

import release_promotion as promotion  # noqa: E402


P1 = "983f79b4900502f35fac6de8154eb344fc9f143b"
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

    @staticmethod
    def manifest(generation: str, schema_version: int = 1) -> dict[str, object]:
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
            "images": {},
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
        if stage == "source_owner":
            contract["source_owner_compat"]["generation"] = predecessor
        else:
            contract.pop("source_owner_compat", None)
        schema_version = 2 if stage in {"cleanup", "target_baseline"} else 1
        manifest = self.manifest(generation, schema_version)
        if stage == "bridge":
            predecessor_manifest = self.manifest(predecessor)
            manifest["namespace_handoff"] = {
                "schema_version": 1,
                "source": {
                    "profile_id": self.base_contract["source_profile_id"],
                    "manager": predecessor_manifest["manager"],
                    "compose": predecessor_manifest["compose"],
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
        for name in promotion.SEALED_RELEASE_ASSETS:
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

    def write_p1_compat(self) -> Path:
        root = self.root / "p1-current"
        root.mkdir(parents=True, exist_ok=True)
        testdata = REPOSITORY_ROOT / "manager/internal/release/testdata"
        shutil.copyfile(
            testdata / f"{P1}-release.json",
            root / "release.json",
        )
        shutil.copyfile(
            testdata / f"{P1}-compose.yaml",
            root / "ubitech-compose.yaml",
        )
        for name in promotion.SEALED_RELEASE_ASSETS:
            path = root / name
            if not path.exists():
                path.write_bytes(f"canonical P1 fixture placeholder for {name}\n".encode())
        return root

    def test_source_owner_preserves_exact_v1_manifest_and_no_receipt(self) -> None:
        root = self.root / A2
        record = self.write_release(
            root,
            stage="source_owner",
            generation=A2,
            predecessor=P1,
            draft=True,
        )
        self.assertEqual(record["manifest_schema_version"], 1)
        self.assertIsNone(record["required_receipt_type"])

        manifest_path = root / "release.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["namespace_handoff"] = {"schema_version": 1}
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(
            promotion.PromotionError, "exact ordinary nine-key shape"
        ):
            promotion.build_promotion(
                root / "release-transition.json",
                manifest_path,
                root / "release-transition-challenge.schema.json",
                root / "release-transition-receipt.schema.json",
                A2,
                root,
            )

    def test_first_promotion_accepts_only_the_contract_pinned_real_p1_release(self) -> None:
        api = json.loads(
            (REPOSITORY_ROOT / "scripts/tests/fixtures/p1-release-api.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(api["tag_name"], f"container-{P1}")
        self.assertFalse(api["draft"])
        self.assertEqual(
            [asset["name"] for asset in api["assets"]],
            list(promotion.SEALED_RELEASE_ASSETS),
        )
        self.assertNotIn("promotion.json", {asset["name"] for asset in api["assets"]})
        api_digests = {asset["name"]: asset["digest"] for asset in api["assets"]}
        fixture_root = self.write_p1_compat()
        for name in ("release.json", "ubitech-compose.yaml"):
            observed = "sha256:" + hashlib.sha256((fixture_root / name).read_bytes()).hexdigest()
            self.assertEqual(observed, api_digests[name])

        contract = copy.deepcopy(self.base_contract)
        validated = promotion.validate_source_owner_compat(fixture_root, contract, P1)
        self.assertEqual(validated["source_commit"], P1)
        self.assertEqual(len(validated["images"]), 10)

        extra = fixture_root / "promotion.json"
        extra.write_text("{}\n", encoding="utf-8")
        with self.assertRaisesRegex(promotion.PromotionError, "exact P1 asset set"):
            promotion.validate_source_owner_compat(fixture_root, contract, P1)
        extra.unlink()

        changed = copy.deepcopy(contract)
        changed["source_owner_compat"]["generation"] = A2
        with self.assertRaisesRegex(promotion.PromotionError, "exact current generation"):
            promotion.validate_source_owner_compat(fixture_root, changed, P1)

        generalized = copy.deepcopy(contract)
        generalized["predecessor_generation"] = A2
        generalized["source_owner_compat"]["generation"] = A2
        generalized_path = self.root / "generalized-legacy-contract.json"
        generalized_path.write_text(json.dumps(generalized), encoding="utf-8")
        with self.assertRaisesRegex(
            promotion.PromotionError, "limited to the canonical P1 generation and bytes"
        ):
            promotion._load_contract(generalized_path)

    def test_promotion_seals_exact_non_self_release_asset_directory(self) -> None:
        root = self.root / A2
        record = self.write_release(
            root,
            stage="source_owner",
            generation=A2,
            predecessor=P1,
            draft=True,
        )
        self.assertEqual(
            [asset["name"] for asset in record["sealed_assets"]],
            list(promotion.SEALED_RELEASE_ASSETS),
        )
        self.assertNotIn("promotion.json", promotion.SEALED_RELEASE_ASSETS)

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
            stage="source_owner",
            generation=A2,
            predecessor=P1,
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

    @staticmethod
    def release_identity(generation: str) -> dict[str, object]:
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
                for index, name in enumerate(promotion.ALL_RELEASE_ASSETS)
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
            )

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
        self.write_release(
            a2_root,
            stage="source_owner",
            generation=A2,
            predecessor=P1,
            draft=True,
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

        first = promotion.select_candidate(
            P1, candidates, None, self.write_p1_compat()
        )
        self.assertEqual(first["candidate"]["generation"], A2)
        second = promotion.select_candidate(A2, candidates, a2_root)
        self.assertEqual(second["candidate"]["generation"], BRIDGE)
        third = promotion.select_candidate(BRIDGE, candidates, bridge_root)
        self.assertEqual(third["candidate"]["generation"], CLEANUP)
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

    def test_selector_rejects_a_candidate_published_outside_the_evaluator(self) -> None:
        candidates = self.root / "candidates"
        self.write_release(
            candidates / A2,
            stage="source_owner",
            generation=A2,
            predecessor=P1,
            draft=False,
        )
        with self.assertRaisesRegex(promotion.PromotionError, "is not draft"):
            promotion.select_candidate(P1, candidates, None)

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
        self.write_release(
            predecessor_root,
            stage="source_owner",
            generation=A2,
            predecessor=P1,
            draft=False,
        )
        self.write_release(
            bridge_root,
            stage="bridge",
            generation=BRIDGE,
            predecessor=A2,
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
            ("observed_generation", P1),
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
        self.assertIn("--current-compat-root", evaluator)
        self.assertIn("canonical P1 release has an unexpected asset directory", evaluator)
        self.assertIn("source_owner_compat.generation", evaluator)
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
        self.assertIn('cmp "$SEALED_IDENTITY" "$before"', evaluator)
        self.assertEqual(evaluator.count('cmp "$SEALED_IDENTITY" "$before"'), 2)
        self.assertEqual(evaluator.count("releases/latest"), 4)
        self.assertIn("REQUESTED_CANDIDATE: ${{ inputs.candidate_generation }}", evaluator)
        self.assertIn('requested="$REQUESTED_CANDIDATE"', evaluator)
        self.assertNotIn("requested='${{ inputs.candidate_generation }}'", evaluator)
        self.assertIn('[[ ! "$CHALLENGE_RUN_ID" =~ ^[1-9][0-9]{0,19}$ ]]', evaluator)
        normalized = " ".join(evaluator.split())
        ordinary = (
            "(steps.select.outputs.candidate_stage == 'source_owner' || "
            "steps.select.outputs.candidate_stage == 'target_baseline')"
        )
        gated = (
            "(steps.select.outputs.candidate_stage == 'bridge' || "
            "steps.select.outputs.candidate_stage == 'cleanup')"
        )
        self.assertIn(ordinary, normalized)
        self.assertEqual(normalized.count(gated), 3)
        self.assertNotIn("candidate_stage != 'source_owner'", evaluator)
        for workflow in (REPOSITORY_ROOT / ".github/workflows").glob("*.yml"):
            if workflow.name == "channel-promotion.yml":
                continue
            self.assertNotIn("--draft=false", workflow.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
