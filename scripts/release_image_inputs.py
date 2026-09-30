#!/usr/bin/env python3
"""Fingerprint tracked Docker inputs and reuse matching public multi-platform images.

Only the repository's constrained Dockerfile dialect is accepted. Ignored tracked
files are deliberately included: extra rebuilds are safer than missed inputs.
Package/network inputs inside RUN are invalidated explicitly with --salt.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import stat
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

COMPONENTS = ("platform", "agent-runtime", "camofox", "agent-sandbox")
LABEL = "io.agent-platform.build-inputs"
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
ACCEPT = ", ".join(("application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json", "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"))


def diagnostic(message):
    print(f"release-image-inputs: {message}", file=sys.stderr)


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"duplicate JSON key: {key}")
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs)


def fetch(url, headers=None):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=30) as response:
        return response.read()


class Registry:
    """Anonymous OCI pulls, including registry bearer-token authentication."""
    def __init__(self):
        self.tokens = {}
        self.cache = {}

    @staticmethod
    def location(reference):
        name, separator, digest = reference.partition("@")
        if separator and not DIGEST.fullmatch(digest):
            raise ValueError(f"invalid image digest: {reference}")
        parts = name.split("/")
        host = parts.pop(0) if len(parts) > 1 and ("." in parts[0] or ":" in parts[0]) else "docker.io"
        if host not in ("docker.io", "index.docker.io", "registry-1.docker.io", "ghcr.io"):
            raise ValueError(f"unsupported registry: {host}")
        name = "/".join(parts)
        repository, colon, tag = name.rpartition(":")
        if not colon:
            repository, tag = name, "latest"
        if host != "ghcr.io":
            host = "registry-1.docker.io"
            if "/" not in repository:
                repository = "library/" + repository
        if not re.fullmatch(r"[a-z0-9][a-z0-9._/-]*", repository):
            raise ValueError(f"invalid repository: {repository}")
        return host, repository, digest if separator else tag

    def get(self, reference, kind="manifests", identity=None):
        host, repository, ref = self.location(reference)
        identity = identity or ref
        url = f"https://{host}/v2/{repository}/{kind}/{urllib.parse.quote(identity, safe=':')}"
        if url in self.cache:
            return self.cache[url]
        key = (host, repository)
        headers = {"Accept": ACCEPT}
        if key in self.tokens:
            headers["Authorization"] = "Bearer " + self.tokens[key]
        try:
            raw = fetch(url, headers)
        except urllib.error.HTTPError as error:
            if error.code != 401:
                raise
            challenge = error.headers.get("WWW-Authenticate", "")
            if not challenge.lower().startswith("bearer "):
                raise ValueError("registry did not offer bearer authentication") from error
            fields = dict(re.findall(r'(\w+)="([^"]*)"', challenge))
            realm = fields.get("realm", "")
            allowed = {"registry-1.docker.io": "auth.docker.io", "ghcr.io": "ghcr.io"}
            parsed = urllib.parse.urlsplit(realm)
            if parsed.scheme != "https" or parsed.netloc != allowed[host]:
                raise ValueError("untrusted registry token endpoint")
            query = urllib.parse.urlencode({"service": fields.get("service", host), "scope": f"repository:{repository}:pull"})
            token = strict_json(fetch(realm + "?" + query))
            self.tokens[key] = token.get("token") or token["access_token"]
            headers["Authorization"] = "Bearer " + self.tokens[key]
            raw = fetch(url, headers)
        actual = "sha256:" + hashlib.sha256(raw).hexdigest()
        if DIGEST.fullmatch(identity) and actual != identity:
            raise ValueError(f"registry content digest mismatch: {reference}")
        result = (actual, strict_json(raw))
        self.cache[url] = result
        return result

    def resolve(self, reference):
        return self.get(reference)[0]

    def labels(self, reference):
        _, index = self.get(reference)
        manifests = index.get("manifests")
        if not isinstance(manifests, list):
            raise ValueError("image is not a multi-platform index")
        platforms = {}
        for descriptor in manifests:
            platform = descriptor.get("platform", {})
            if platform.get("os") != "linux":
                continue
            arch = platform.get("architecture")
            if arch not in ("amd64", "arm64") or arch in platforms:
                raise ValueError("image index has unexpected or duplicate Linux architecture")
            if platform.get("variant", "") not in (("", "v8") if arch == "arm64" else ("",)):
                raise ValueError("unsupported image platform variant")
            digest = descriptor.get("digest", "")
            if not DIGEST.fullmatch(digest):
                raise ValueError("invalid platform manifest digest")
            _, manifest = self.get(reference, identity=digest)
            config_digest = manifest["config"]["digest"]
            if not DIGEST.fullmatch(config_digest):
                raise ValueError("invalid config digest")
            _, config = self.get(reference, "blobs", config_digest)
            if config.get("os") != "linux" or config.get("architecture") != arch:
                raise ValueError("image config platform disagrees with index")
            platforms[arch] = (config.get("config", {}).get("Labels") or {}).get(LABEL)
        if set(platforms) != {"amd64", "arm64"}:
            raise ValueError("image index lacks both Linux architectures")
        return platforms


def docker_inputs(text):
    """Return literal local COPY paths and resolved-default image references.

    Reject ADD, external COPY stages, bind/secret/SSH mounts, heredocs, COPY
    variables/globs and nonstandard parser directives rather than underhashing.
    """
    sources, bases, stages, defaults = set(), set(), set(), {}
    pending = ""
    stage_count = 0
    for physical in text.splitlines():
        line = physical.strip()
        if not line or line.startswith("#"):
            if line.startswith("#") and "=" in line:
                directive, value = line[1:].strip().split("=", 1)
                if directive.strip() == "syntax":
                    bases.add(value.strip())
                elif directive.strip() in ("escape", "check"):
                    raise ValueError("unsupported Dockerfile parser directive")
            continue
        pending += line[:-1] + " " if line.endswith("\\") else line
        if line.endswith("\\"):
            continue
        instruction, _, body = pending.partition(" ")
        pending = ""
        instruction = instruction.upper()
        if instruction not in ("ARG", "LABEL") and re.search(r"\$\{?(?:SOURCE_COMMIT|RELEASE_VERSION)\b", body):
            raise ValueError("release metadata arguments may only be consumed by LABEL")
        if "<<" in body:
            raise ValueError("Dockerfile heredocs are unsupported")
        if instruction in ("ADD", "ONBUILD"):
            raise ValueError(f"unsupported Dockerfile instruction: {instruction}")
        if instruction == "ARG":
            name, separator, value = body.partition("=")
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                raise ValueError("unsupported ARG syntax")
            if separator:
                values = shlex.split(value)
                if len(values) > 1 or "$" in value:
                    raise ValueError("unsupported ARG default")
                if not stage_count:
                    defaults[name] = values[0] if values else ""
            elif name not in defaults and name not in ("TARGETARCH", "TARGETOS", "TARGETPLATFORM", "TARGETVARIANT", "BUILDPLATFORM", "BUILDARCH", "BUILDOS", "BUILDVARIANT", "SOURCE_COMMIT", "RELEASE_VERSION"):
                raise ValueError(f"ARG requires a default: {name}")
        elif instruction == "FROM":
            words = shlex.split(body)
            if words and words[0].startswith("--platform="):
                if words.pop(0) not in ("--platform=$BUILDPLATFORM", "--platform=$TARGETPLATFORM", "--platform=linux/amd64", "--platform=linux/arm64"):
                    raise ValueError("unsupported FROM platform")
            if len(words) not in (1, 3) or (len(words) == 3 and words[1].upper() != "AS"):
                raise ValueError("unsupported FROM syntax")
            def expand(match):
                name = match.group(1) or match.group(2)
                if name not in defaults:
                    raise ValueError(f"FROM ARG has no global default: {name}")
                return defaults[name]
            base = re.sub(r"\$\{(\w+)\}|\$(\w+)", expand, words[0])
            if "$" in base:
                raise ValueError("unsupported FROM expansion")
            if base.lower() not in stages and base != "scratch":
                bases.add(base)
            stages.add(str(stage_count))
            stage_count += 1
            if len(words) == 3:
                stages.add(words[2].lower())
        elif instruction == "COPY":
            from_stage = None
            while body.startswith("--"):
                flag, _, body = body.partition(" ")
                body = body.lstrip()
                if flag.startswith("--from="):
                    from_stage = flag.split("=", 1)[1].lower()
                elif not re.fullmatch(r"--(?:chown|chmod)=[a-zA-Z0-9_:.-]+|--link(?:=true|=false)?", flag):
                    raise ValueError(f"unsupported COPY option: {flag}")
            words = strict_json(body) if body.startswith("[") else shlex.split(body)
            if not isinstance(words, list) or len(words) < 2 or not all(isinstance(word, str) for word in words):
                raise ValueError("unsupported COPY syntax")
            if from_stage is not None:
                if from_stage not in stages:
                    raise ValueError("COPY --from must reference an earlier build stage")
                continue
            for source in words[:-1]:
                if any(char in source for char in "$*?[]\\") or "://" in source or ".." in PurePosixPath(source).parts:
                    raise ValueError(f"unsupported local COPY source: {source}")
                sources.add(str(PurePosixPath(source.lstrip("/"))))
        elif instruction == "RUN":
            for mount in re.findall(r"--mount=([^\s]+)", body):
                fields = dict(part.split("=", 1) if "=" in part else (part, "") for part in mount.split(","))
                if fields.get("type", "bind") != "cache" or "from" in fields or "source" in fields or "src" in fields:
                    raise ValueError("only independent RUN cache mounts are supported")
            if body.startswith("--") and not body.startswith("--mount="):
                raise ValueError("unsupported RUN option")
        elif instruction not in ("ENV", "WORKDIR", "LABEL", "USER", "EXPOSE", "HEALTHCHECK", "ENTRYPOINT", "CMD", "SHELL", "STOPSIGNAL", "VOLUME", "MAINTAINER"):
            raise ValueError(f"unsupported Dockerfile instruction: {instruction}")
    if pending or not stage_count:
        raise ValueError("incomplete Dockerfile")
    return sources, bases


def tracked_paths(root):
    raw = subprocess.check_output(["git", "ls-files", "--stage", "-z"], cwd=root)
    paths = set()
    for entry in raw.split(b"\0"):
        if not entry:
            continue
        meta, path = entry.split(b"\t", 1)
        mode, _, stage = meta.split()
        if mode == b"160000" or stage != b"0":
            raise ValueError("submodules and unmerged files are unsupported build contexts")
        paths.add(os.fsdecode(path))
    return paths


def fingerprint(root, component, salt, tracked, registry):
    dockerfile = f"containers/{component}.Dockerfile"
    sources, bases = docker_inputs((root / dockerfile).read_text())
    selected = {dockerfile, "scripts/release_image_inputs.py", "docs/contracts/container-platform.json"}
    for ignore in (".dockerignore", dockerfile + ".dockerignore"):
        if ignore in tracked:
            selected.add(ignore)
        elif (root / ignore).exists():
            raise ValueError(f"untracked Docker ignore file: {ignore}")
    for source in sources:
        # Docker dereferences a directly named COPY symlink, unlike links inside
        # a copied directory. Reject it rather than omit its target's contents.
        if (root / source).is_symlink():
            raise ValueError(f"direct COPY symlink is unsupported: {source}")
        matches = {path for path in tracked if source == "." or path == source or path.startswith(source + "/")}
        if not matches:
            raise ValueError(f"COPY source has no tracked files: {source}")
        selected.update(matches)
    if not selected <= tracked:
        raise ValueError(f"required build inputs are not tracked: {sorted(selected - tracked)}")
    hasher = hashlib.sha256()
    def add(value):
        encoded = value if isinstance(value, bytes) else value.encode()
        hasher.update(len(encoded).to_bytes(8, "big"))
        hasher.update(encoded)
    add(component)
    add(salt)
    add("linux/amd64,linux/arm64")
    add("SOURCE_DATE_EPOCH=0" if component == "agent-sandbox" else "")
    contexts = []
    for base in sorted(bases):
        digest = registry.resolve(base)
        add(base)
        add(digest)
        # Already immutable references need no override (and @ is not a context name).
        if "@" not in base:
            contexts.append(f"{base}=docker-image://{base}@{digest}")
    for path in sorted(selected):
        full = root / path
        for parent in full.relative_to(root).parents:
            if (root / parent).is_symlink():
                raise ValueError(f"symlink directory in build input: {path}")
        mode = full.lstat().st_mode
        add(path)
        add(str(stat.S_IMODE(mode)))
        if stat.S_ISLNK(mode):
            add("symlink")
            add(os.readlink(full))
        elif stat.S_ISREG(mode):
            add("file")
            add(full.read_bytes())
        else:
            raise ValueError(f"unsupported build input file type: {path}")
    return hasher.hexdigest(), "\n".join(contexts)


def previous_images(url):
    try:
        previous = strict_json(fetch(url))
        if not isinstance(previous, dict) or type(previous.get("schema_version")) is not int or previous["schema_version"] != 2 or type(previous.get("protocol_version")) is not int or previous["protocol_version"] != 2 or previous.get("channel") != "main" or not isinstance(previous.get("images"), dict):
            raise ValueError("previous release is not a main schema-2/protocol-2 manifest")
        return previous["images"]
    except (OSError, ValueError, TypeError, KeyError) as error:
        diagnostic(f"previous release unavailable; building images: {error}")
        return {}


def reuse_digest(reference, previous, expected, registry):
    try:
        if not isinstance(previous, str) or not previous.startswith(reference + "@") or not DIGEST.fullmatch(previous[len(reference) + 1:]):
            raise ValueError("previous image missing or repository/digest does not match")
        labels = registry.labels(previous)
        diagnostic(f"{reference}: previous {LABEL} labels {json.dumps(labels, sort_keys=True)}")
        if labels != {"amd64": expected, "arm64": expected}:
            raise ValueError("previous architecture labels do not both match current inputs")
        return previous.split("@", 1)[1]
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        diagnostic(f"{reference}: building: {error}")
        return ""


def matrix(root, repository, salt, previous, registry):
    tracked = tracked_paths(root)
    rows = []
    for component in COMPONENTS:
        value, contexts = fingerprint(root, component, salt, tracked, registry)
        reference = f"ghcr.io/{repository.lower()}/{component}"
        reuse = reuse_digest(reference, previous.get(component), value, registry)
        rows.append(dict(component=component, dockerfile=f"containers/{component}.Dockerfile", image=component, tag_suffix="", fingerprint=value, reuse_digest=reuse, base_contexts=contexts))
    return {"include": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--salt", required=True)
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--previous-release")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repository):
        parser.error("--repository must be OWNER/REPO")
    try:
        previous = previous_images(args.previous_release or f"https://github.com/{args.repository}/releases/latest/download/release.json")
        print(json.dumps(matrix(args.root.resolve(), args.repository, args.salt, previous, Registry()), separators=(",", ":")))
    except (OSError, ValueError, TypeError, KeyError, subprocess.CalledProcessError) as error:
        diagnostic(f"cannot resolve current build inputs: {error}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
