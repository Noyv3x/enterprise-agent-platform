"""Deployment CLI kept compatible with the host Manager."""
import argparse
from dataclasses import replace
import json
from pathlib import Path

from .config import Settings
from .db import Database


def main():
    parser = argparse.ArgumentParser(description='Agent Platform')
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('serve', 'migrate', 'init-admin', 'print-agent-token'):
        command = commands.add_parser(name)
        command.add_argument('--data')
        if name == 'serve':
            command.add_argument('--host')
            command.add_argument('--port', type=int)
        elif name == 'init-admin':
            command.add_argument('username')
            command.add_argument('password')
            command.add_argument('--display-name', default='')
    args = parser.parse_args()
    settings = Settings.from_env()
    if args.data:
        settings = replace(settings, data_dir=Path(args.data).expanduser().resolve())
    if args.command == 'serve':
        import uvicorn
        from .app import create_app
        uvicorn.run(create_app(settings), host=args.host or settings.host, port=args.port or settings.port)
        return
    db = Database(settings.database_path)
    db.migrate(settings.data_dir)
    if args.command == 'migrate':
        print(json.dumps({'ok': True, 'schema_version': db.schema_version()}))
    elif args.command == 'init-admin':
        from .admin import create_user
        user = create_user(db, args.username, args.password, display_name=args.display_name, role='admin')
        print(f"created admin user: {user['username']}")
    else:
        with db.connect() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key='agent_tool_token'").fetchone()
        print(settings.agent_tool_token or (row['value'] if row else ''))


if __name__ == '__main__':
    main()
