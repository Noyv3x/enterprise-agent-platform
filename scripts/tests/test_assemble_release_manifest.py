from __future__ import annotations

import argparse
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import assemble_release_manifest as assembler  # noqa: E402


PREDECESSOR = "3fa84952c56a6daf2a9a18825778c54b2d150cf1"
CANDIDATE = "b" * 40


class AssembleReleaseManifestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.contract = json.loads(
            (ROOT / "docs/contracts/release-transition.json").read_text(encoding="utf-8")
        )
        self.contract_path = self.root / "contract.json"
        self.predecessor_path = self.root / "predecessor.json"
        self.images_path = self.root / "images.json"
        self.contract_path.write_text(json.dumps(self.contract), encoding="utf-8")
        self.predecessor = self._manifest(PREDECESSOR)
        self.predecessor_path.write_text(json.dumps(self.predecessor), encoding="utf-8")
        self.images = {
            name: f"ghcr.io/example/{name}@sha256:{index:064x}"
            for index, name in enumerate(sorted(assembler.MANAGED_V2), 1)
        }
        self.images_path.write_text(json.dumps(self.images), encoding="utf-8")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def set_stage(self, stage: str) -> None:
        contract = dict(self.contract)
        contract["stage"] = stage
        if stage == "bridge":
            contract["predecessor_generation"] = PREDECESSOR
        self.contract_path.write_text(json.dumps(contract), encoding="utf-8")
        managed = assembler.MANAGED_V1 if stage == "bridge" else assembler.MANAGED_V2
        self.images = {
            name: f"ghcr.io/example/{name}@sha256:{index:064x}"
            for index, name in enumerate(sorted(managed), 1)
        }
        self.images_path.write_text(json.dumps(self.images), encoding="utf-8")

    @staticmethod
    def _manifest(generation: str) -> dict[str, object]:
        return {
            "schema_version": 1,
            "channel": "main",
            "source_commit": generation,
            "generated_at": "2026-01-01T00:00:00Z",
            "protocol_version": 1,
            "database_schema_version": 1,
            "manager": {
                "version": generation,
                "artifacts": {
                    "amd64": {"url": "https://example.invalid/old-amd64", "sha256": "1" * 64},
                    "arm64": {"url": "https://example.invalid/old-arm64", "sha256": "2" * 64},
                },
            },
            "compose": {"url": "https://example.invalid/old-compose", "sha256": "3" * 64},
            "images": {
                name: f"ghcr.io/example/{name}@sha256:{index:064x}"
                for index, name in enumerate(sorted(assembler.MANAGED_V1), 1)
            },
        }

    def args(self) -> argparse.Namespace:
        return argparse.Namespace(
            contract=self.contract_path,
            predecessor_manifest=None,
            images=self.images_path,
            generation=CANDIDATE,
            generated_at="2026-08-01T00:00:00+00:00",
            database_schema_version=2026072901,
            manager_amd64_url="https://example.invalid/new-amd64",
            manager_amd64_sha256="4" * 64,
            manager_arm64_url="https://example.invalid/new-arm64",
            manager_arm64_sha256="5" * 64,
            compose_url="https://example.invalid/new-compose",
            compose_sha256="6" * 64,
            output=self.root / "output.json",
        )

    def test_bridge_binds_exact_predecessor_and_target(self) -> None:
        self.set_stage("bridge")
        args = self.args()
        args.predecessor_manifest = self.predecessor_path
        manifest = assembler.assemble(args)
        handoff = manifest["namespace_handoff"]
        self.assertEqual(set(manifest), assembler.ORDINARY_KEYS | {"namespace_handoff"})
        self.assertEqual(handoff["predecessor_generation"], PREDECESSOR)
        self.assertEqual(handoff["bridge_generation"], CANDIDATE)
        self.assertEqual(handoff["source"]["manager"], self.predecessor["manager"])
        self.assertEqual(handoff["source"]["compose"], self.predecessor["compose"])
        self.assertEqual(handoff["target"]["manager"], manifest["manager"])
        self.assertEqual(handoff["target"]["compose"], manifest["compose"])

    def test_rejects_predecessor_projection_or_wrong_generation(self) -> None:
        self.set_stage("bridge")
        for mutation in ("extra", "generation"):
            with self.subTest(mutation=mutation):
                value = copy.deepcopy(self.predecessor)
                if mutation == "extra":
                    value["unexpected"] = True
                else:
                    value["source_commit"] = "a" * 40
                self.predecessor_path.write_text(json.dumps(value), encoding="utf-8")
                with self.assertRaises(assembler.ManifestAssemblyError):
                    args = self.args()
                    args.predecessor_manifest = self.predecessor_path
                    assembler.assemble(args)

    def test_rejects_missing_helper_or_unverified_image(self) -> None:
        self.set_stage("bridge")
        for mutation in ("missing", "tag"):
            with self.subTest(mutation=mutation):
                images = dict(self.images)
                if mutation == "missing":
                    images.pop("handoff-fs-helper")
                else:
                    images["platform"] = "ghcr.io/example/platform:latest"
                self.images_path.write_text(json.dumps(images), encoding="utf-8")
                with self.assertRaises(assembler.ManifestAssemblyError):
                    args = self.args()
                    args.predecessor_manifest = self.predecessor_path
                    assembler.assemble(args)

    def test_cleanup_and_target_baseline_are_schema_v2_without_source_inputs(self) -> None:
        for stage in ("cleanup", "target_baseline"):
            with self.subTest(stage=stage):
                self.set_stage(stage)
                args = self.args()
                args.predecessor_manifest = None
                manifest = assembler.assemble(args)
                self.assertEqual(set(manifest), assembler.ORDINARY_KEYS)
                self.assertEqual(manifest["schema_version"], 2)
                self.assertEqual(manifest["protocol_version"], 2)
                self.assertEqual(set(manifest["images"]), assembler.MANAGED_V2)

                args.predecessor_manifest = self.predecessor_path
                with self.assertRaisesRegex(
                    assembler.ManifestAssemblyError,
                    "must not consume a source predecessor manifest",
                ):
                    assembler.assemble(args)

    def test_target_only_rejects_helper(self) -> None:
        self.set_stage("cleanup")
        images = dict(self.images)
        images["handoff-fs-helper"] = (
            "ghcr.io/example/handoff-fs-helper@sha256:" + "7" * 64
        )
        self.images_path.write_text(json.dumps(images), encoding="utf-8")
        args = self.args()
        with self.assertRaisesRegex(
            assembler.ManifestAssemblyError, "schema-v2 managed digest set"
        ):
            assembler.assemble(args)

    def test_generated_at_is_strict_rfc3339_and_normalized_to_utc_z(self) -> None:
        cases = {
            "2026-08-01T08:30:45+08:00": "2026-08-01T00:30:45Z",
            "2026-07-31T19:30:45-05:00": "2026-08-01T00:30:45Z",
            "2026-08-01T00:30:45.125000+00:00": "2026-08-01T00:30:45.125000Z",
            "2026-08-01T00:30:45Z": "2026-08-01T00:30:45Z",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                args = self.args()
                args.generated_at = raw
                self.assertEqual(assembler.assemble(args)["generated_at"], expected)

        for invalid in (
            "2026-08-01T00:30:45",
            "2026-08-01",
            "2026-02-30T00:00:00Z",
            "2026-08-01T00:00:00+25:00",
            "2026-08-01 00:00:00Z",
            "2026-08-01T00:00:00z",
        ):
            with self.subTest(invalid=invalid):
                args = self.args()
                args.generated_at = invalid
                with self.assertRaises(assembler.ManifestAssemblyError):
                    assembler.assemble(args)


if __name__ == "__main__":
    unittest.main()
