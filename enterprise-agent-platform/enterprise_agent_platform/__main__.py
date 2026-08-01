from __future__ import annotations

import argparse
import json
from dataclasses import replace
from pathlib import Path

from .config import PlatformConfig
from .db import Database
from .server import run_server
from .service import EnterpriseService


def main() -> None:
    parser = argparse.ArgumentParser(description="Agent Platform")
    sub = parser.add_subparsers(dest="cmd", required=True)

    serve = sub.add_parser("serve", help="Start the web platform")
    serve.add_argument("--host", default=None)
    serve.add_argument("--port", type=int, default=None)
    serve.add_argument("--data", default=None)

    init_admin = sub.add_parser("init-admin", help="Create an admin user")
    init_admin.add_argument("username")
    init_admin.add_argument("password")
    init_admin.add_argument("--display-name", default="")
    init_admin.add_argument("--data", default=None)

    token = sub.add_parser("print-agent-token", help="Print the internal Agent tool token")
    token.add_argument("--data", default=None)
    migrate = sub.add_parser("migrate", help="Apply database migrations and exit")
    migrate.add_argument("--data", default=None)
    args = parser.parse_args()
    cmd = args.cmd

    config = PlatformConfig.from_env(Path(__file__).resolve().parents[1])
    if getattr(args, "data", None):
        config = replace(config, data_dir=Path(args.data).expanduser().resolve())
    if getattr(args, "host", None):
        config = replace(config, host=args.host)
    if getattr(args, "port", None):
        config = replace(config, port=args.port)

    if cmd == "serve":
        run_server(config)
        return
    if cmd == "migrate":
        database = Database(config.db_path, config.technical_profile)
        try:
            version = int(
                database.scalar(
                    "SELECT COALESCE(MAX(version), 0) FROM schema_migrations"
                )
                or 0
            )
            print(json.dumps({"ok": True, "schema_version": version}))
        finally:
            database.close()
        return

    service = EnterpriseService(config)
    try:
        if cmd == "init-admin":
            user = service.create_user(
                username=args.username,
                password=args.password,
                display_name=args.display_name,
                role="admin",
                actor=None,
            )
            print(f"created admin user: {user['username']}")
        elif cmd == "print-agent-token":
            row = service.db.query_one("SELECT value FROM settings WHERE key = 'agent_tool_token'")
            print(row["value"] if row else "")
    finally:
        service.close()


if __name__ == "__main__":
    main()
