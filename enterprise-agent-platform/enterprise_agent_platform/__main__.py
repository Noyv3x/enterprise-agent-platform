from __future__ import annotations

import argparse
from dataclasses import replace
from pathlib import Path

from .config import PlatformConfig
from .server import run_server
from .service import EnterpriseService


def main() -> None:
    parser = argparse.ArgumentParser(description="ubitech agent")
    sub = parser.add_subparsers(dest="cmd")

    serve = sub.add_parser("serve", help="Start the web platform")
    serve.add_argument("--host", default=None)
    serve.add_argument("--port", type=int, default=None)
    serve.add_argument("--data", default=None)
    serve.add_argument("--listen-host", default=None, help=argparse.SUPPRESS)
    serve.add_argument("--listen-port", type=int, default=None, help=argparse.SUPPRESS)

    gateway = sub.add_parser("gateway", help="Start the persistent platform gateway")
    from .gateway import add_gateway_args

    add_gateway_args(gateway)

    init_admin = sub.add_parser("init-admin", help="Create an admin user")
    init_admin.add_argument("username")
    init_admin.add_argument("password")
    init_admin.add_argument("--display-name", default="")
    init_admin.add_argument("--data", default=None)

    token = sub.add_parser("print-agent-token", help="Print the internal Agent tool token")
    token.add_argument("--data", default=None)
    deploy = sub.add_parser("deploy", help="Bootstrap one-command deployment")
    from .deployment import add_bootstrap_args

    add_bootstrap_args(deploy)

    args = parser.parse_args()
    cmd = args.cmd or "serve"
    if cmd == "deploy":
        from .deployment import bootstrap_from_args

        bootstrap_from_args(args)
        return

    config = PlatformConfig.from_env(Path(__file__).resolve().parents[1])
    if getattr(args, "data", None):
        config = replace(config, data_dir=Path(args.data).expanduser().resolve())
    if getattr(args, "host", None):
        config = replace(config, host=args.host)
    if getattr(args, "port", None):
        config = replace(config, port=args.port)

    if cmd == "serve":
        run_server(
            config,
            listen_host=getattr(args, "listen_host", None),
            listen_port=getattr(args, "listen_port", None),
        )
        return
    if cmd == "gateway":
        from .gateway import run_gateway

        run_gateway(config, mode=args.mode)
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
    finally:
        service.close()


if __name__ == "__main__":
    main()
