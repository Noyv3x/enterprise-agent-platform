from __future__ import annotations

import argparse
import os
import shutil
from dataclasses import replace
from pathlib import Path

from .config import PlatformConfig
from .server import run_server
from .service import EnterpriseService


def main() -> None:
    parser = argparse.ArgumentParser(description="Enterprise Agent Platform")
    sub = parser.add_subparsers(dest="cmd")

    serve = sub.add_parser("serve", help="Start the web platform")
    serve.add_argument("--host", default=None)
    serve.add_argument("--port", type=int, default=None)
    serve.add_argument("--data", default=None)

    init_admin = sub.add_parser("init-admin", help="Create an admin user")
    init_admin.add_argument("username")
    init_admin.add_argument("password")
    init_admin.add_argument("--display-name", default="")
    init_admin.add_argument("--data", default=None)

    token = sub.add_parser("print-agent-token", help="Print the Hermes plugin token")
    token.add_argument("--data", default=None)
    install_plugin = sub.add_parser("install-hermes-plugin", help="Install the enterprise_kb Hermes plugin into HERMES_HOME")
    install_plugin.add_argument("--hermes-home", default=None)

    args = parser.parse_args()
    cmd = args.cmd or "serve"
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

    service = EnterpriseService(config, autostart_runtime=False)
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
        elif cmd == "install-hermes-plugin":
            src = Path(__file__).resolve().parents[1] / "hermes_plugin" / "enterprise_kb"
            home = Path(args.hermes_home or os.getenv("HERMES_HOME", "~/.hermes")).expanduser()
            dest = home / "plugins" / "enterprise_kb"
            if dest.exists():
                shutil.rmtree(dest)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(src, dest)
            print(f"installed Hermes plugin: {dest}")
            print("Enable plugin key 'enterprise-kb' in Hermes config plugins.enabled.")
    finally:
        service.close()


if __name__ == "__main__":
    main()
