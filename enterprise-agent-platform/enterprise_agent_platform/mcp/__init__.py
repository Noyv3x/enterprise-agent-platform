"""MCP connectors: Platform owns credentials, connections, catalogs, calls and audit; Runtime only proxies calls."""
from .api import routes as api_routes
from .models import McpError
from .service import McpService

__all__ = ['McpError', 'McpService', 'routes']


def routes(service):
    return [*api_routes(), *service.oauth.routes()]
