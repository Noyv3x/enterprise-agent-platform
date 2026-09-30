"""Consumer-visible release reuse and constrained Docker input behavior."""
import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("release_image_inputs", Path(__file__).parents[1] / "release_image_inputs.py")
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)
D1 = "sha256:" + "1" * 64
D2 = "sha256:" + "2" * 64


class FakeRegistry:
    def __init__(self):
        self.digest = D1
        self.by_reference = {}

    def resolve(self, reference):
        return self.digest

    def labels(self, reference):
        return self.by_reference[reference]


class InputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.registry = FakeRegistry()
        self.tracked = set()
        for name, content in {
            "scripts/release_image_inputs.py": "algorithm",
            "docs/contracts/container-platform.json": "{}",
            "docs/guide.md": "guide",
            "src/runtime.js": "runtime",
            "src/link": "unused",
            "containers/agent-runtime.Dockerfile": "ARG BASE=node:24\nFROM ${BASE} AS build\nCOPY src /app\nFROM node:24\nCOPY --from=build /app /app\n",
            "containers/agent-runtime.Dockerfile.dockerignore": "**\n!src/**\n",
        }.items():
            self.put(name, content)
        (self.root / "src/link").unlink()
        (self.root / "src/link").symlink_to("runtime.js")
        self.stderr = contextlib.redirect_stderr(io.StringIO())
        self.stderr.__enter__()
        self.addCleanup(self.stderr.__exit__, None, None, None)

    def put(self, name, content):
        file = self.root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content)
        self.tracked.add(name)

    def fingerprint(self, salt="1"):
        return helper.fingerprint(self.root, "agent-runtime", salt, self.tracked, self.registry)

    def reuse(self, value):
        ref = "ghcr.io/owner/repo/agent-runtime"
        return helper.reuse_digest(ref, ref + "@" + D1, value, self.registry)

    def seed(self):
        value, contexts = self.fingerprint()
        self.registry.by_reference["ghcr.io/owner/repo/agent-runtime@" + D1] = {"amd64": value, "arm64": value}
        return value, contexts

    def test_unchanged_and_docs_only_reuse(self):
        value, contexts = self.seed()
        self.put("docs/guide.md", "new guide")
        (self.root / "src/generated.js").write_text("untracked build output")
        self.assertEqual(self.fingerprint()[0], value)
        self.assertEqual(self.reuse(value), D1)
        self.assertEqual(contexts, f"node:24=docker-image://node:24@{D1}")

    def test_runtime_base_salt_and_policy_changes_rebuild(self):
        original, _ = self.seed()
        self.assertEqual(self.reuse(self.fingerprint("2")[0]), "")
        self.registry.digest = D2
        self.assertEqual(self.reuse(self.fingerprint()[0]), "")
        self.registry.digest = D1
        self.put("src/runtime.js", "changed runtime")
        self.assertEqual(self.reuse(self.fingerprint()[0]), "")
        self.put("src/runtime.js", "runtime")
        self.put("docs/contracts/container-platform.json", '{"capacity":2}')
        self.assertNotEqual(self.fingerprint()[0], original)

    def test_modes_symlinks_ignore_and_helper_changes_invalidate(self):
        original, _ = self.seed()
        (self.root / "src/runtime.js").chmod(0o755)
        self.assertNotEqual(self.fingerprint()[0], original)
        (self.root / "src/runtime.js").chmod(0o644)
        (self.root / "src/link").unlink()
        (self.root / "src/link").symlink_to("other.js")
        self.assertNotEqual(self.fingerprint()[0], original)
        self.put("scripts/release_image_inputs.py", "new algorithm")
        self.assertNotEqual(self.fingerprint()[0], original)

    def test_missing_tracked_file_fails(self):
        (self.root / "src/runtime.js").unlink()
        with self.assertRaises(FileNotFoundError):
            self.fingerprint()

    def test_direct_copy_symlink_is_rejected(self):
        self.put("containers/agent-runtime.Dockerfile", "FROM node:24\nCOPY src/link /app/file\n")
        with self.assertRaisesRegex(ValueError, "direct COPY symlink"):
            self.fingerprint()

    def test_current_base_failure_is_fatal(self):
        with patch.object(self.registry, "resolve", side_effect=OSError("offline")):
            with self.assertRaises(OSError):
                self.fingerprint()

    def test_disagreeing_architecture_labels_and_wrong_repository_rebuild(self):
        value, _ = self.seed()
        self.registry.by_reference["ghcr.io/owner/repo/agent-runtime@" + D1]["arm64"] = "different"
        self.assertEqual(self.reuse(value), "")
        self.assertEqual(helper.reuse_digest("ghcr.io/other/repo/agent-runtime", "ghcr.io/owner/repo/agent-runtime@" + D1, value, self.registry), "")
        self.assertEqual(helper.reuse_digest("ghcr.io/owner/repo/agent-runtime", None, value, self.registry), "")

    def test_missing_malformed_or_wrong_channel_previous_builds(self):
        for document in (b"bad json", b"[]", b'{"schema_version":2,"protocol_version":2,"channel":"preview","images":{}}', b'{"schema_version":2,"schema_version":2}'):
            with self.subTest(document=document), patch.object(helper, "fetch", return_value=document):
                self.assertEqual(helper.previous_images("https://example/release.json"), {})
        with patch.object(helper, "fetch", side_effect=OSError("404")):
            self.assertEqual(helper.previous_images("https://example/release.json"), {})

    def test_unsupported_inputs_rejected(self):
        for instruction in ("ADD https://example/file /file", "COPY --from=external /file /file", "COPY src/*.js /app/", "COPY $INPUT /app/", "RUN --mount=type=bind,source=src,target=/src cat /src/file", "RUN --mount=type=secret,id=token cat /run/secrets/token", "ONBUILD COPY src /app", "ARG SECRET", "COPY ../file /file", "FROM $UNKNOWN"):
            with self.subTest(instruction=instruction), self.assertRaises(ValueError):
                helper.docker_inputs("FROM node:24\n" + instruction + "\n")
        with self.assertRaisesRegex(ValueError, "only be consumed by LABEL"):
            helper.docker_inputs('FROM node:24\nARG SOURCE_COMMIT=unknown\nRUN echo "$SOURCE_COMMIT" > /revision\n')

    def test_json_copy_and_pinned_base(self):
        sources, bases = helper.docker_inputs(f'FROM node:24@{D1}\nCOPY ["src", "/app"]\n')
        self.assertEqual(sources, {"src"})
        self.assertEqual(bases, {f"node:24@{D1}"})
        self.put("containers/agent-runtime.Dockerfile", f"FROM node:24@{D1}\nCOPY src /app\n")
        self.assertEqual(self.fingerprint()[1], "")

    def test_git_tracks_only_indexed_files(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        subprocess.run(["git", "-C", str(self.root), "add", "."], check=True)
        (self.root / "src/output.js").write_text("untracked")
        self.assertEqual(helper.tracked_paths(self.root), self.tracked)


class RegistryTests(unittest.TestCase):
    def index_registry(self, architectures):
        registry = helper.Registry()
        manifests = [{"digest": "sha256:" + str(i + 3) * 64, "platform": {"os": "linux", "architecture": arch}} for i, arch in enumerate(architectures)]
        def get(reference, kind="manifests", identity=None):
            if identity is None:
                return D1, {"manifests": manifests}
            if kind == "manifests":
                return identity, {"config": {"digest": identity}}
            index = next(i for i, item in enumerate(manifests) if item["digest"] == identity)
            return identity, {"os": "linux", "architecture": architectures[index], "config": {"Labels": {helper.LABEL: "fingerprint"}}}
        registry.get = get
        return registry

    def test_two_unique_architectures_required(self):
        self.assertEqual(self.index_registry(["amd64", "arm64"]).labels("image"), {"amd64": "fingerprint", "arm64": "fingerprint"})
        for arches in (["amd64"], ["amd64", "amd64", "arm64"], ["amd64", "arm64", "s390x"]):
            with self.subTest(arches=arches), self.assertRaises(ValueError):
                self.index_registry(arches).labels("image")

    def test_registry_digest_bytes_verified(self):
        with patch.object(helper, "fetch", return_value=b"{}"):
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                helper.Registry().get("ghcr.io/owner/image@" + D1)


if __name__ == "__main__":
    unittest.main()
