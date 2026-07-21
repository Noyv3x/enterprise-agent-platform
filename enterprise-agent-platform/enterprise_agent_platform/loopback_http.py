from __future__ import annotations

import ipaddress
import urllib.parse
import urllib.request


class RejectRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Prevent a validated loopback request from leaving its original URL."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_http_base_url(value: str) -> urllib.parse.SplitResult:
    """Validate a credential-free HTTP(S) base URL for a trusted service."""

    raw = str(value or "")
    if raw != raw.strip() or any(
        ord(character) < 32 or ord(character) == 127 for character in raw
    ):
        raise ValueError("service endpoint must be a credential-free HTTP(S) base URL")
    try:
        parsed = urllib.parse.urlsplit(raw)
        port = parsed.port
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or (port is not None and not 1 <= port <= 65535)
        ):
            raise ValueError
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError(
            "service endpoint must be a credential-free HTTP(S) base URL"
        ) from exc
    return parsed


def validate_loopback_url(
    value: str,
    *,
    base_url: bool = False,
    require_port: bool = False,
) -> urllib.parse.SplitResult:
    """Validate a credential-free HTTP(S) URL with a numeric loopback host.

    Hostnames such as ``localhost`` are deliberately rejected. Resolving a
    hostname would make the trust decision depend on mutable DNS or hosts-file
    state; the internal-service boundary is instead expressed directly in the
    configured URL.
    """

    raw = str(value or "")
    if raw != raw.strip() or any(
        ord(character) < 32 or ord(character) == 127 for character in raw
    ):
        raise ValueError(
            "loopback HTTP requests require a credential-free numeric loopback URL"
        )
    try:
        parsed = urllib.parse.urlsplit(raw)
        hostname = str(parsed.hostname or "")
        port = parsed.port
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or not hostname
            or parsed.username is not None
            or parsed.password is not None
            or not ipaddress.ip_address(hostname).is_loopback
            or parsed.fragment
            or (port is not None and not 1 <= port <= 65535)
            or (require_port and port is None)
            or (
                base_url
                and (parsed.path not in {"", "/"} or bool(parsed.query))
            )
        ):
            raise ValueError
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError(
            "loopback HTTP requests require a credential-free numeric loopback URL"
        ) from exc
    return parsed


def build_loopback_opener() -> urllib.request.OpenerDirector:
    """Build an opener that ignores proxy variables and refuses redirects."""

    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        RejectRedirectHandler(),
    )


def build_trusted_service_opener() -> urllib.request.OpenerDirector:
    """Build a normal proxy-aware opener that never forwards across redirects."""

    return urllib.request.build_opener(RejectRedirectHandler())


def open_trusted_service_url(
    request: urllib.request.Request,
    *,
    timeout: float,
):
    """Open a trusted HTTP(S) service URL without forwarding auth on redirects."""

    try:
        parsed = urllib.parse.urlsplit(request.full_url)
        port = parsed.port
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
            or (port is not None and not 1 <= port <= 65535)
        ):
            raise ValueError
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError(
            "trusted service requests require a credential-free HTTP(S) URL"
        ) from exc
    return build_trusted_service_opener().open(request, timeout=timeout)


def open_loopback_url(request: urllib.request.Request, *, timeout: float):
    """Open only a literal loopback HTTP(S) URL without proxies or redirects."""

    validate_loopback_url(request.full_url)
    return build_loopback_opener().open(request, timeout=timeout)
