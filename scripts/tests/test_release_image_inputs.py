"""Consumer-visible release reuse and constrained Docker input behavior."""
import contextlib
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import io
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
from threading import Barrier, Lock
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
        self.assertEqual(contexts, f"node:24=docker-image://docker.io/library/node@{D1}")

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

    def test_concurrent_matrix_matches_sequential_rows(self):
        previous = {}
        expected = []
        for component in helper.COMPONENTS:
            self.put(f"containers/{component}.Dockerfile", "FROM node:24 AS build\nCOPY src /app\nFROM alpine:3\nCOPY --from=build /app /app\n")
            value, contexts = helper.fingerprint(self.root, component, "1", self.tracked, self.registry)
            reference = f"ghcr.io/owner/repo/{component}@{D1}"
            previous[component] = reference
            self.registry.by_reference[reference] = {"amd64": value, "arm64": value}
            expected.append(dict(component=component, dockerfile=f"containers/{component}.Dockerfile", image=component, tag_suffix="", fingerprint=value, reuse_digest=D1, base_contexts=contexts))
        # One differing architecture must still rebuild only its own component.
        self.registry.by_reference[previous["camofox"]]["arm64"] = "different"
        expected[2]["reuse_digest"] = ""
        fingerprint = helper.fingerprint
        started = Barrier(4, timeout=5)
        def concurrent_fingerprint(*args):
            started.wait()
            return fingerprint(*args)
        with patch.object(helper, "tracked_paths", return_value=self.tracked), patch.object(helper, "fingerprint", side_effect=concurrent_fingerprint):
            actual = helper.matrix(self.root, "Owner/Repo", "1", previous, self.registry)
        self.assertEqual(actual, {"include": expected})

    def test_independent_base_resolutions_overlap(self):
        self.put("containers/agent-runtime.Dockerfile", "FROM node:24 AS build\nFROM alpine:3\nCOPY src /app\n")
        started = Barrier(2, timeout=5)
        def resolve(reference):
            started.wait()
            return {"node:24": D1, "alpine:3": D2}[reference]
        with patch.object(self.registry, "resolve", side_effect=resolve):
            _, contexts = self.fingerprint()
        self.assertEqual(contexts, f"alpine:3=docker-image://docker.io/library/alpine@{D2}\nnode:24=docker-image://docker.io/library/node@{D1}")

    def test_contexts_never_look_like_url_credentials(self):
        # GitHub's runner masks `scheme://user:password@` and then drops the whole job output.
        self.put("containers/agent-runtime.Dockerfile", "# syntax=docker/dockerfile:1.7\nFROM node:24.14.0-bookworm-slim AS build\nFROM python:3.11-slim-bookworm\nCOPY src /app\n")
        _, contexts = self.fingerprint()
        self.assertEqual(len(contexts.splitlines()), 3)
        self.assertIsNone(re.search(r"://[^\s/:@]+:[^\s@]+@", contexts))


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

    def test_shared_reference_requests_and_failures_are_single_flight(self):
        for failure in (False, True):
            with self.subTest(failure=failure):
                registry = helper.Registry()
                started = Barrier(4, timeout=5)
                calls = []
                lock = Lock()
                error = OSError("offline")
                def fetch(url, headers):
                    with lock:
                        calls.append(url)
                    if failure:
                        raise error
                    return b"{}"
                def resolve(reference):
                    started.wait()
                    return registry.resolve(reference)
                # Equivalent spellings, as used by different Dockerfiles, share a URL.
                references = ("node:24", "docker.io/library/node:24", "index.docker.io/node:24", "registry-1.docker.io/library/node:24")
                with patch.object(helper, "fetch", side_effect=fetch), ThreadPoolExecutor(max_workers=4) as executor:
                    futures = [executor.submit(resolve, reference) for reference in references]
                    if failure:
                        for future in futures:
                            with self.assertRaises(OSError) as raised:
                                future.result(timeout=5)
                            self.assertIs(raised.exception, error)
                    else:
                        expected = "sha256:" + helper.hashlib.sha256(b"{}").hexdigest()
                        self.assertEqual([future.result(timeout=5) for future in futures], [expected] * 4)
                self.assertEqual(calls, ["https://registry-1.docker.io/v2/library/node/manifests/24"])

    def test_parallel_requests_share_bearer_token(self):
        for failure in (False, True):
            with self.subTest(failure=failure):
                registry = helper.Registry()
                unauthorized = Barrier(2, timeout=5)
                token_calls = []
                lock = Lock()
                def fetch(url, headers=None):
                    if url.startswith("https://auth.docker.io/"):
                        with lock:
                            token_calls.append(url)
                        if failure:
                            raise OSError("token unavailable")
                        return b'{"token":"shared"}'
                    if "Authorization" not in headers:
                        unauthorized.wait()
                        raise helper.urllib.error.HTTPError(url, 401, "unauthorized", {"WWW-Authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"'}, None)
                    self.assertEqual(headers["Authorization"], "Bearer shared")
                    return b"{}"
                with patch.object(helper, "fetch", side_effect=fetch), ThreadPoolExecutor(max_workers=2) as executor:
                    futures = [executor.submit(registry.get, "node:" + tag) for tag in ("22", "24")]
                    for future in futures:
                        if failure:
                            with self.assertRaisesRegex(OSError, "token unavailable"):
                                future.result(timeout=5)
                        else:
                            self.assertEqual(future.result(timeout=5)[1], {})
                self.assertEqual(len(token_calls), 1)

    def test_architecture_config_chains_overlap(self):
        registry = self.index_registry(["amd64", "arm64"])
        get = registry.get
        started = Barrier(2, timeout=5)
        def concurrent_get(reference, kind="manifests", identity=None):
            if kind == "manifests" and identity is not None:
                started.wait()
            return get(reference, kind, identity)
        registry.get = concurrent_get
        self.assertEqual(registry.labels("image"), {"amd64": "fingerprint", "arm64": "fingerprint"})


if __name__ == "__main__":
    unittest.main()
