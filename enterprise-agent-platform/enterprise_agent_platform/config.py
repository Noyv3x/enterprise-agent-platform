"""Container configuration; tenant execution never receives this environment."""
from dataclasses import dataclass, field
import os
from pathlib import Path
import secrets


@dataclass
class Settings:
    data_dir: Path = Path('/var/lib/agent-platform')
    session_secret: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    agent_tool_token: str = ''
    runtime_token: str = ''
    runtime_url: str = 'http://agent-runtime:8766'
    manager_socket: str = '/run/agent-platform-manager/manager.sock'
    manager_token_file: Path = Path('/run/secrets/agent-platform/manager-token')
    camofox_url: str = 'http://camofox:9377'
    camofox_access_key: str = ''
    searxng_url: str = 'http://searxng:8080'
    public_base_url: str = 'http://127.0.0.1:8080'
    trusted_proxy: bool = False
    frontend_dir: Path = Path(__file__).parent / 'static'
    host: str = '127.0.0.1'
    port: int = 8765
    deployment_mode: str = 'development'

    @property
    def database_path(self) -> Path:
        return self.data_dir / 'platform.db'

    @classmethod
    def from_env(cls):
        def value(name, default=''):
            return os.environ.get('AGENT_PLATFORM_' + name, default).strip()
        def secret(name):
            direct = value(name)
            file = value(name + '_FILE')
            if direct and file:
                raise ValueError(f'{name} and {name}_FILE cannot both be set')
            if file:
                path = Path(file)
                if path.is_symlink() or not path.is_file():
                    raise ValueError(f'{name}_FILE must be a regular file')
                direct = path.read_text().strip()
                if not direct:
                    raise ValueError(f'{name}_FILE is empty')
            return direct
        return cls(
            data_dir=Path(value('DATA', '/var/lib/agent-platform')).expanduser(),
            session_secret=secret('SESSION_SECRET') or secrets.token_urlsafe(32),
            agent_tool_token=secret('AGENT_TOOL_TOKEN'),
            runtime_token=secret('AGENT_RUNTIME_TOKEN'),
            runtime_url=value('AGENT_RUNTIME_URL', 'http://agent-runtime:8766').rstrip('/'),
            manager_socket=value('MANAGER_SOCKET', '/run/agent-platform-manager/manager.sock'),
            manager_token_file=Path(value('MANAGER_TOKEN_FILE', '/run/secrets/agent-platform/manager-token')),
            camofox_url=value('CAMOFOX_URL', 'http://camofox:9377').rstrip('/'),
            camofox_access_key=secret('CAMOFOX_ACCESS_KEY'),
            searxng_url=value('SEARXNG_API_URL', 'http://searxng:8080').rstrip('/'),
            public_base_url=value('PUBLIC_BASE_URL', 'http://127.0.0.1:8080').rstrip('/'),
            trusted_proxy=value('TRUSTED_PROXY').lower() in ('1', 'true', 'yes'),
            host=value('HOST', '127.0.0.1'), port=int(value('PORT', '8765')),
            deployment_mode=value('DEPLOYMENT_MODE', 'development'),
        )
