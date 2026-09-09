#!/usr/bin/env python3
"""Offline command boundary for extracted release workflow steps; no network calls."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

root = Path(os.environ['FIXTURE_ROOT'])
name = Path(sys.argv[0]).name
args = sys.argv[1:]
with (root / 'calls.jsonl').open('a') as log:
    log.write(json.dumps([name, *args]) + '\n')
source = os.environ.get('SOURCE_COMMIT', 'a' * 40)
scenario = os.environ.get('FIXTURE_SCENARIO', '')
changed = (root / 'changed').exists()
published = (root / 'published').exists()

def emit(value):
    print(json.dumps(value))

def reject():
    print('Unhandled fake command: ' + repr([name, *args]), file=sys.stderr)
    sys.exit(97)

if name == 'npm':
    if args == ['ci']:
        Path('node_modules').mkdir(exist_ok=True)
    if args not in (['ci'], ['test'], ['run', 'check'], ['run', 'build']):
        reject()
    sys.exit(42 if args == (['ci'] if scenario == 'ci' else ['test']) else 0)
elif name == 'git':
    if 'diff' in args:
        sys.stdout.write('enterprise-agent-platform/frontend/src/example.ts\0')
    elif 'ls-files' in args:
        pass
    elif 'init' in args:
        (Path(args[1]) / 'firecrawl').mkdir()
    elif 'checkout' in args:
        (Path(args[1]) / 'docker-compose.yaml').write_text('services: {}\n')
    elif 'rev-parse' in args:
        print(os.environ.get('FIXTURE_REVISION', source))
    elif 'remote' in args or 'fetch' in args or 'merge-base' in args:
        pass
    else:
        reject()
elif name == 'docker':
    if args[:1] != ['compose']:
        reject()
    print('api\nnuq-postgres\nplaywright-service\nrabbitmq\nredis')
elif name == 'verify-release-images-anonymous.sh':
    (root / 'changed').touch()
elif name == 'gh':
    if args[:2] == ['release', 'view']:
        print('https://api.github.com/repos/fixture/example/releases/10')
    elif args[:2] == ['release', 'download']:
        destination = Path(args[args.index('--dir') + 1])
        for path in (root / 'release').iterdir():
            shutil.copyfile(path, destination / path.name)
    elif args[:2] == ['release', 'edit']:
        (root / 'published').touch()
    elif args[:1] == ['api']:
        endpoint = next((arg for arg in args[1:] if arg.startswith('/repos/')), '')
        if endpoint.endswith('/actions/runs/123'):
            emit({'id': 123, 'run_attempt': 2 if changed and scenario == 'quality' else 1,
                  'path': '.github/workflows/quality.yml', 'event': 'push',
                  'status': 'in_progress' if changed and scenario == 'quality' else 'completed',
                  'conclusion': None if changed and scenario == 'quality' else 'success',
                  'head_branch': 'main', 'head_sha': source,
                  'head_repository': {'full_name': 'fixture/example'}})
        elif endpoint.endswith('/actions/runs/456'):
            emit({'id': 456, 'run_attempt': 2 if changed and scenario == 'own-run-late' else 1,
                  'status': 'in_progress', 'conclusion': None,
                  'path': '.github/workflows/container-release.yml',
                  'event': 'workflow_run', 'head_branch': 'main', 'head_sha': 'c' * 40 if scenario == 'own-run' else os.environ['GITHUB_SHA'],
                  'head_repository': {'full_name': 'fixture/example'}})
        elif '/git/ref/tags/' in endpoint:
            emit({'object': {'type': 'commit', 'sha': source}})
        elif endpoint.endswith('/releases/latest'):
            emit({'tag_name': 'container-' + (source if published else 'b' * 40)})
        elif endpoint.endswith('/releases/10'):
            assets = []
            for index, path in enumerate(sorted((root / 'release').iterdir()), 1):
                assets.append({'id': index + (100 if changed and scenario == 'asset' else 0),
                               'name': path.name, 'state': 'uploaded', 'size': path.stat().st_size,
                               'digest': 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()})
            emit({'id': 10, 'tag_name': 'container-' + source, 'target_commitish': source,
                  'prerelease': False, 'draft': not published, 'assets': assets})
        else:
            reject()
    else:
        reject()
else:
    reject()
