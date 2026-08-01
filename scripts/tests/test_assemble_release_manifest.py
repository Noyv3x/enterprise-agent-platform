from __future__ import annotations

import argparse
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

import assemble_release_manifest as assembler  # noqa: E402


CANDIDATE = "b" * 40


class AssembleReleaseManifestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.images_path = self.root / "images.json"
        self.images = {
            name: f"ghcr.io/example/{name}@sha256:{index:064x}"
            for index, name in enumerate(sorted(assembler.MANAGED_IMAGES), 1)
        }
        self.images_path.write_text(json.dumps(self.images), encoding="utf-8")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def args(self) -> argparse.Namespace:
        base = "https://example.invalid/container-" + CANDIDATE
        return argparse.Namespace(
            images=self.images_path,
            generation=CANDIDATE,
            generated_at="2026-08-01T00:00:00+00:00",
            database_schema_version=2026072901,
            manager_amd64_url=base + "/agent-platform-manager-linux-amd64",
            manager_amd64_sha256="4" * 64,
            manager_arm64_url=base + "/agent-platform-manager-linux-arm64",
            manager_arm64_sha256="5" * 64,
            compose_url=base + "/agent-platform-compose.yaml",
            compose_sha256="6" * 64,
            output=self.root / "output.json",
        )

    def test_assembles_only_current_schema_and_exact_images(self) -> None:
        manifest = assembler.assemble(self.args())
        self.assertEqual(manifest["schema_version"], 2)
        self.assertEqual(manifest["protocol_version"], 2)
        self.assertEqual(manifest["source_commit"], CANDIDATE)
        self.assertEqual(manifest["manager"]["version"], CANDIDATE)
        self.assertEqual(set(manifest["images"]), assembler.MANAGED_IMAGES)
        self.assertEqual(
            set(manifest),
            {
                "schema_version", "channel", "source_commit", "generated_at",
                "protocol_version", "database_schema_version", "manager",
                "compose", "images",
            },
        )

    def test_rejects_missing_unknown_or_mutable_image(self) -> None:
        for mutation in ("missing", "unknown", "tag"):
            with self.subTest(mutation=mutation):
                images = dict(self.images)
                if mutation == "missing":
                    images.pop("platform")
                elif mutation == "unknown":
                    images["unknown"] = images.pop("platform")
                else:
                    images["platform"] = "ghcr.io/example/platform:latest"
                self.images_path.write_text(json.dumps(images), encoding="utf-8")
                with self.assertRaises(assembler.ManifestAssemblyError):
                    assembler.assemble(self.args())

    def test_artifacts_require_exact_https_basename_and_digest(self) -> None:
        mutations = {
            "scheme": ("manager_amd64_url", "http://example.invalid/agent-platform-manager-linux-amd64"),
            "malformed": ("manager_amd64_url", "https://[/agent-platform-manager-linux-amd64"),
            "credentials": ("manager_amd64_url", "https://user@example.invalid/agent-platform-manager-linux-amd64"),
            "query": ("manager_amd64_url", "https://example.invalid/agent-platform-manager-linux-amd64?x=1"),
            "basename": ("manager_amd64_url", "https://example.invalid/manager"),
            "compose": ("compose_url", "https://example.invalid/compose.yaml"),
            "digest": ("manager_amd64_sha256", "bad"),
        }
        for name, (field, value) in mutations.items():
            with self.subTest(name=name):
                args = self.args()
                setattr(args, field, value)
                with self.assertRaises(assembler.ManifestAssemblyError):
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
