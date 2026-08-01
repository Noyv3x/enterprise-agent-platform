from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
VERIFIER = REPOSITORY_ROOT / "scripts/verify-release-images-anonymous.sh"
COMPONENTS = (
    "agent-runtime",
    "agent-sandbox",
    "camofox",
    "firecrawl-api",
    "firecrawl-playwright",
    "firecrawl-postgres",
    "firecrawl-rabbitmq",
    "firecrawl-redis",
    "handoff-fs-helper",
    "platform",
    "searxng",
)


class AnonymousReleaseImageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        fake_curl = self.bin / "curl"
        fake_curl.write_text(
            """#!/usr/bin/env bash
set -euo pipefail
if [[ -n "${GH_TOKEN+x}" || -n "${GITHUB_TOKEN+x}" ]]; then
  echo "credential leaked to anonymous curl" >&2
  exit 88
fi
url="${*: -1}"
if [[ "$url" == */token ]]; then
  if [[ "${FAKE_TOKEN_FAILURE:-}" == 1 ]]; then
    exit 22
  fi
  printf '%s\\n' '{"token":"anonymous"}'
elif [[ "$url" == */manifests/sha256:* ]]; then
  digest="${url##*/}"
  if [[ "${FAKE_BAD_DIGEST:-}" == 1 ]]; then
    digest="sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
  fi
  printf 'HTTP/2 200\\r\\ndocker-content-digest: %s\\r\\n\\r\\n' "$digest"
else
  echo "unexpected curl URL: $url" >&2
  exit 89
fi
""",
            encoding="utf-8",
        )
        fake_curl.chmod(0o755)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    @staticmethod
    def images() -> dict[str, str]:
        values: dict[str, str] = {}
        for index, component in enumerate(COMPONENTS, start=1):
            if component == "firecrawl-redis":
                reference = "redis"
            elif component == "firecrawl-rabbitmq":
                reference = "rabbitmq"
            else:
                reference = f"ghcr.io/example/{component}"
            values[component] = f"{reference}@sha256:{index:064x}"
        return values

    def run_verifier(
        self,
        images: dict[str, str],
        *,
        schema_version: int = 1,
        include_handoff: bool | None = None,
        **environment: str,
    ) -> subprocess.CompletedProcess[str]:
        manifest = self.root / "release.json"
        value: dict[str, object] = {
            "schema_version": schema_version,
            "protocol_version": schema_version,
            "images": images,
        }
        if include_handoff is None:
            include_handoff = schema_version == 1
        if include_handoff:
            value["namespace_handoff"] = {}
        manifest.write_text(json.dumps(value), encoding="utf-8")
        env = os.environ.copy()
        env.update(environment)
        env["PATH"] = f"{self.bin}:{env['PATH']}"
        env["GH_TOKEN"] = "must-not-leak"
        env["GITHUB_TOKEN"] = "must-not-leak"
        return subprocess.run(
            [str(VERIFIER), str(manifest)],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )

    def test_exact_eleven_public_digests_are_verified_without_credentials(self) -> None:
        result = self.run_verifier(self.images())
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_schema_v2_verifies_exact_ten_and_rejects_helper_or_handoff(self) -> None:
        images = self.images()
        images.pop("handoff-fs-helper")
        result = self.run_verifier(images, schema_version=2)
        self.assertEqual(result.returncode, 0, result.stderr)

        with_helper = self.images()
        self.assertNotEqual(
            self.run_verifier(with_helper, schema_version=2).returncode, 0
        )
        self.assertNotEqual(
            self.run_verifier(
                images, schema_version=2, include_handoff=True
            ).returncode,
            0,
        )

    def test_closed_image_directory_rejects_missing_or_unknown_component(self) -> None:
        missing = self.images()
        missing.pop("platform")
        self.assertNotEqual(self.run_verifier(missing).returncode, 0)

        unknown = self.images()
        unknown["unknown"] = unknown.pop("platform")
        self.assertNotEqual(self.run_verifier(unknown).returncode, 0)

    def test_registry_unavailability_or_digest_mismatch_fails_closed(self) -> None:
        token_failure = self.run_verifier(self.images(), FAKE_TOKEN_FAILURE="1")
        self.assertNotEqual(token_failure.returncode, 0)
        mismatch = self.run_verifier(self.images(), FAKE_BAD_DIGEST="1")
        self.assertNotEqual(mismatch.returncode, 0)
        self.assertIn("Anonymous registry returned", mismatch.stderr)


if __name__ == "__main__":
    unittest.main()
