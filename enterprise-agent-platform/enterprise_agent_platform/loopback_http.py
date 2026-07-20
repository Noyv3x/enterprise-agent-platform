from __future__ import annotations

import ipaddress
import urllib.parse
import urllib.request


class RejectRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Prevent a validated loopback request from leaving its original URL."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def build_loopback_opener() -> urllib.request.OpenerDirector:
    """Build an opener that ignores proxy variables and refuses redirects."""

    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        RejectRedirectHandler(),
    )


def open_loopback_url(request: urllib.request.Request, *, timeout: float):
    """Open only a literal loopback HTTP(S) URL without proxies or redirects."""

    try:
        parsed = urllib.parse.urlsplit(request.full_url)
        hostname = str(parsed.hostname or "").rstrip(".")
        if (
            parsed.scheme not in {"http", "https"}
            or not hostname
            or parsed.username is not None
            or parsed.password is not None
            or not ipaddress.ip_address(hostname).is_loopback
        ):
            raise ValueError
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError(
            "loopback HTTP requests require a credential-free numeric loopback URL"
        ) from exc
    return build_loopback_opener().open(request, timeout=timeout)
