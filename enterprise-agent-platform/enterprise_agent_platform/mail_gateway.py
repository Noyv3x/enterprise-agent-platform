from __future__ import annotations

import imaplib
import re
import smtplib
import socket
import ssl
from dataclasses import dataclass
from datetime import date
from email import policy
from email.message import EmailMessage, Message
from email.parser import BytesParser
from email.utils import formatdate, getaddresses, make_msgid, parsedate_to_datetime
from html.parser import HTMLParser
from typing import Any, Iterable


MAIL_CONNECT_TIMEOUT_SECONDS = 20.0
MAX_MAIL_MESSAGE_BYTES = 25 * 1024 * 1024
MAX_MAIL_ATTACHMENT_BYTES = 25 * 1024 * 1024
MAX_MAIL_BODY_CHARACTERS = 200_000
MAX_MAIL_SUBJECT_CHARACTERS = 998
MAX_MAIL_RESULTS = 50
MAX_MAIL_WAKE_BATCH = 10
MAX_MAIL_UID_SCAN_SPAN = 5_000
MAX_MAIL_RECIPIENTS = 50
MAIL_SECURITY_MODES = frozenset({"tls", "starttls"})


class MailGatewayError(Exception):
    """A bounded, credential-free mail integration failure."""

    def __init__(self, message: str, *, temporary: bool = False, uncertain: bool = False):
        super().__init__(str(message)[:2_000])
        self.temporary = bool(temporary)
        self.uncertain = bool(uncertain)


@dataclass(frozen=True)
class MailboxCheckpoint:
    uid_validity: int
    highest_uid: int
    uids: tuple[int, ...]
    more_available: bool = False


class _HTMLTextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []

    def handle_data(self, data: str) -> None:
        clean = str(data or "").strip()
        if clean:
            self._parts.append(clean)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.casefold() in {"br", "p", "div", "li", "tr", "h1", "h2", "h3"}:
            self._parts.append("\n")

    def text(self) -> str:
        return re.sub(r"\n{3,}", "\n\n", " ".join(self._parts)).strip()


def _safe_header(value: Any, *, field: str, maximum: int) -> str:
    clean = str(value or "").strip()
    if not clean:
        return ""
    if len(clean) > maximum:
        raise MailGatewayError(f"{field} is too long")
    if any(character in clean for character in "\r\n\x00"):
        raise MailGatewayError(f"{field} contains invalid control characters")
    return clean


def normalize_mail_addresses(value: Any, *, field: str, required: bool = False) -> list[str]:
    if value is None:
        raw_values: list[str] = []
    elif isinstance(value, str):
        raw_values = [value]
    elif isinstance(value, list) and all(isinstance(item, str) for item in value):
        raw_values = list(value)
    else:
        raise MailGatewayError(f"{field} must be an address or list of addresses")
    for raw in raw_values:
        _safe_header(raw, field=field, maximum=4_096)
    addresses: list[str] = []
    for display_name, address in getaddresses(raw_values):
        _safe_header(display_name, field=field, maximum=998)
        clean = _safe_header(address, field=field, maximum=320)
        if not clean or "@" not in clean or clean.startswith("@") or clean.endswith("@"):
            raise MailGatewayError(f"{field} contains an invalid email address")
        addresses.append(clean)
    if required and not addresses:
        raise MailGatewayError(f"{field} is required")
    if len(addresses) > MAX_MAIL_RECIPIENTS:
        raise MailGatewayError("too many email recipients")
    return addresses


def normalize_folder(value: Any, *, default: str = "INBOX") -> str:
    folder = str(value or default).strip()
    if not folder:
        folder = default
    if len(folder) > 512 or any(ord(character) < 32 or ord(character) == 127 for character in folder):
        raise MailGatewayError("mail folder is invalid")
    return folder


def normalize_uid(value: Any) -> int:
    try:
        uid = int(value)
    except (TypeError, ValueError) as exc:
        raise MailGatewayError("mail UID must be a positive integer") from exc
    if uid <= 0 or uid > 2**63 - 1:
        raise MailGatewayError("mail UID must be a positive integer")
    return uid


def _quoted_mailbox(folder: str) -> str:
    return '"' + folder.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _response_bytes(data: Any) -> bytes:
    if not isinstance(data, (list, tuple)):
        return b""
    for item in data:
        if isinstance(item, tuple) and len(item) >= 2 and isinstance(item[1], bytes):
            return item[1]
        if isinstance(item, bytes) and item and not item.startswith(b")"):
            return item
    return b""


def _imap_ok(status: Any, *, operation: str) -> None:
    if str(status or "").upper() != "OK":
        raise MailGatewayError(f"mail server rejected {operation}", temporary=True)


def _selected_number(client: imaplib.IMAP4, name: str) -> int:
    response = client.response(name)
    raw = b" ".join(
        item for item in (response[1] or []) if isinstance(item, bytes)
    )
    match = re.search(rb"([0-9]+)", raw)
    value = int(match.group(1)) if match else 0
    if value <= 0:
        raise MailGatewayError(
            f"mail server did not provide a valid {name}", temporary=True
        )
    return value


def _metadata_bytes(data: Any) -> bytes:
    return b" ".join(
        item[0] if isinstance(item, tuple) and item and isinstance(item[0], bytes) else item
        for item in (data or [])
        if isinstance(item, (bytes, tuple))
    )


def _parse_flags(data: Any) -> list[str]:
    joined = b" ".join(
        item[0] if isinstance(item, tuple) and item and isinstance(item[0], bytes) else item
        for item in (data or [])
        if isinstance(item, (bytes, tuple))
    )
    match = re.search(rb"FLAGS \(([^)]*)\)", joined, re.IGNORECASE)
    if not match:
        return []
    return sorted(
        token.decode("ascii", errors="replace")
        for token in match.group(1).split()
        if token
    )


def _message_date(message: Message) -> str:
    value = str(message.get("Date") or "").strip()
    if not value:
        return ""
    try:
        parsed = parsedate_to_datetime(value)
        return parsed.isoformat() if parsed is not None else value[:512]
    except (TypeError, ValueError, OverflowError):
        return value[:512]


def _decoded_text(part: Message) -> str:
    try:
        content = part.get_content()
        if isinstance(content, str):
            return content
    except (LookupError, UnicodeError, TypeError):
        pass
    payload = part.get_payload(decode=True) or b""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except LookupError:
        return payload.decode("utf-8", errors="replace")


def _message_body(message: Message) -> tuple[str, bool]:
    plain: list[str] = []
    html: list[str] = []
    parts: Iterable[Message] = message.walk() if message.is_multipart() else (message,)
    for part in parts:
        if part.is_multipart() or part.get_filename():
            continue
        disposition = (part.get_content_disposition() or "").casefold()
        if disposition == "attachment":
            continue
        content_type = part.get_content_type().casefold()
        if content_type == "text/plain":
            plain.append(_decoded_text(part))
        elif content_type == "text/html":
            html.append(_decoded_text(part))
    if plain:
        return "\n\n".join(plain)[:MAX_MAIL_BODY_CHARACTERS], False
    if html:
        parser = _HTMLTextExtractor()
        try:
            parser.feed("\n".join(html)[: MAX_MAIL_BODY_CHARACTERS * 4])
        except Exception:
            return "", True
        return parser.text()[:MAX_MAIL_BODY_CHARACTERS], True
    return "", False


def _attachment_metadata(message: Message) -> list[dict[str, Any]]:
    attachments: list[dict[str, Any]] = []
    for index, part in enumerate(message.walk() if message.is_multipart() else (message,)):
        filename = str(part.get_filename() or "").strip()
        disposition = (part.get_content_disposition() or "").casefold()
        if not filename and disposition != "attachment":
            continue
        payload = part.get_payload(decode=True) or b""
        attachments.append(
            {
                "index": index,
                "filename": filename[:512] or f"attachment-{len(attachments) + 1}",
                "content_type": str(part.get_content_type() or "application/octet-stream")[:255],
                "size_bytes": len(payload),
            }
        )
        if len(attachments) >= 100:
            break
    return attachments


def public_message(message: Message, *, uid: int, flags: list[str]) -> dict[str, Any]:
    body, from_html = _message_body(message)
    return {
        "uid": int(uid),
        "message_id": str(message.get("Message-ID") or "")[:998],
        "subject": str(message.get("Subject") or "")[:MAX_MAIL_SUBJECT_CHARACTERS],
        "from": str(message.get("From") or "")[:2_000],
        "to": str(message.get("To") or "")[:4_000],
        "cc": str(message.get("Cc") or "")[:4_000],
        "date": _message_date(message),
        "flags": flags,
        "body": body,
        "body_from_html": from_html,
        "attachments": _attachment_metadata(message),
    }


class MailTransport:
    """Strict standard-library IMAP/SMTP adapter.

    Account dictionaries come from the trusted Platform database. Passwords are
    supplied only to the connection closure and are never added to results.
    """

    def __init__(self, *, timeout: float = MAIL_CONNECT_TIMEOUT_SECONDS) -> None:
        self.timeout = max(1.0, min(float(timeout), 120.0))
        self.ssl_context = ssl.create_default_context()

    def _imap(self, account: dict[str, Any], password: str) -> imaplib.IMAP4:
        security = str(account.get("imap_security") or "").casefold()
        if security not in MAIL_SECURITY_MODES:
            raise MailGatewayError("unsupported IMAP security mode")
        host = str(account.get("imap_host") or "").strip()
        port = int(account.get("imap_port") or 0)
        if security == "tls":
            client: imaplib.IMAP4 = imaplib.IMAP4_SSL(
                host, port, ssl_context=self.ssl_context, timeout=self.timeout
            )
        else:
            client = imaplib.IMAP4(host, port, timeout=self.timeout)
            status, _ = client.starttls(ssl_context=self.ssl_context)
            _imap_ok(status, operation="IMAP STARTTLS")
        status, _ = client.login(str(account.get("username") or ""), password)
        _imap_ok(status, operation="IMAP authentication")
        return client

    def _smtp(self, account: dict[str, Any], password: str) -> smtplib.SMTP:
        security = str(account.get("smtp_security") or "").casefold()
        if security not in MAIL_SECURITY_MODES:
            raise MailGatewayError("unsupported SMTP security mode")
        host = str(account.get("smtp_host") or "").strip()
        port = int(account.get("smtp_port") or 0)
        if security == "tls":
            client: smtplib.SMTP = smtplib.SMTP_SSL(
                host, port, timeout=self.timeout, context=self.ssl_context
            )
        else:
            client = smtplib.SMTP(host, port, timeout=self.timeout)
            client.ehlo()
            client.starttls(context=self.ssl_context)
            client.ehlo()
        client.login(str(account.get("username") or ""), password)
        return client

    @staticmethod
    def _close_imap(client: imaplib.IMAP4 | None) -> None:
        if client is None:
            return
        try:
            client.logout()
        except Exception:
            pass

    @staticmethod
    def _close_smtp(client: smtplib.SMTP | None) -> None:
        if client is None:
            return
        try:
            client.quit()
        except Exception:
            try:
                client.close()
            except Exception:
                pass

    def test(self, account: dict[str, Any], password: str) -> dict[str, bool]:
        imap: imaplib.IMAP4 | None = None
        smtp: smtplib.SMTP | None = None
        try:
            imap = self._imap(account, password)
            status, _ = imap.noop()
            _imap_ok(status, operation="IMAP NOOP")
            smtp = self._smtp(account, password)
            code, _ = smtp.noop()
            if int(code) >= 400:
                raise MailGatewayError("mail server rejected SMTP NOOP", temporary=True)
            return {"imap": True, "smtp": True}
        finally:
            self._close_imap(imap)
            self._close_smtp(smtp)

    def checkpoint(
        self,
        account: dict[str, Any],
        password: str,
        *,
        folder: str,
        after_uid: int = 0,
        limit: int = MAX_MAIL_RESULTS,
        expected_uid_validity: int | None = None,
    ) -> MailboxCheckpoint:
        client: imaplib.IMAP4 | None = None
        try:
            client = self._imap(account, password)
            status, _ = client.select(_quoted_mailbox(normalize_folder(folder)), readonly=True)
            _imap_ok(status, operation="mailbox selection")
            uid_validity = _selected_number(client, "UIDVALIDITY")
            highest_mailbox_uid = _selected_number(client, "UIDNEXT") - 1
            clean_after_uid = max(0, int(after_uid))
            if (
                clean_after_uid <= 0
                or (
                    expected_uid_validity is not None
                    and int(expected_uid_validity) != uid_validity
                )
            ):
                return MailboxCheckpoint(
                    uid_validity=uid_validity,
                    highest_uid=highest_mailbox_uid,
                    uids=(),
                    more_available=False,
                )
            if clean_after_uid >= highest_mailbox_uid:
                return MailboxCheckpoint(
                    uid_validity=uid_validity,
                    highest_uid=clean_after_uid,
                    uids=(),
                    more_available=False,
                )
            clean_limit = max(1, min(int(limit), MAX_MAIL_RESULTS))
            scan_span = MAX_MAIL_UID_SCAN_SPAN
            scan_end = min(highest_mailbox_uid, clean_after_uid + scan_span)
            criterion = f"UID {clean_after_uid + 1}:{scan_end}"
            status, data = client.uid("search", None, criterion)
            _imap_ok(status, operation="mail search")
            uid_bytes = b" ".join(item for item in (data or []) if isinstance(item, bytes))
            uids = sorted({int(item) for item in uid_bytes.split() if item.isdigit() and int(item) > 0})
            matching = tuple(uid for uid in uids if clean_after_uid < uid <= scan_end)
            selected = matching[:clean_limit]
            scanned_through = selected[-1] if len(matching) > clean_limit else scan_end
            return MailboxCheckpoint(
                uid_validity=uid_validity,
                highest_uid=scanned_through,
                uids=selected,
                more_available=scanned_through < highest_mailbox_uid,
            )
        finally:
            self._close_imap(client)

    def folders(self, account: dict[str, Any], password: str) -> list[dict[str, Any]]:
        client: imaplib.IMAP4 | None = None
        try:
            client = self._imap(account, password)
            status, data = client.list()
            _imap_ok(status, operation="folder listing")
            result: list[dict[str, Any]] = []
            for raw in data or []:
                if not isinstance(raw, bytes):
                    continue
                text = raw.decode("utf-8", errors="replace")[:2_000]
                match = re.match(r"^\((?P<flags>[^)]*)\)\s+(?P<delimiter>\S+)\s+(?P<name>.*)$", text)
                if not match:
                    continue
                name = match.group("name").strip().strip('"')
                result.append(
                    {
                        "name": name[:512],
                        "delimiter": match.group("delimiter").strip('"')[:8],
                        "flags": [item for item in match.group("flags").split() if item],
                    }
                )
                if len(result) >= 500:
                    break
            return result
        finally:
            self._close_imap(client)

    def _fetch_message(
        self,
        account: dict[str, Any],
        password: str,
        *,
        folder: str,
        uid: int,
    ) -> tuple[Message, list[str]]:
        client: imaplib.IMAP4 | None = None
        try:
            client = self._imap(account, password)
            status, _ = client.select(_quoted_mailbox(normalize_folder(folder)), readonly=True)
            _imap_ok(status, operation="mailbox selection")
            clean_uid = str(normalize_uid(uid))
            status, metadata = client.uid("fetch", clean_uid, "(RFC822.SIZE FLAGS)")
            _imap_ok(status, operation="message size read")
            match = re.search(
                rb"RFC822\.SIZE\s+([0-9]+)",
                _metadata_bytes(metadata),
                re.IGNORECASE,
            )
            if not match:
                raise MailGatewayError(
                    "mail server did not provide message size", temporary=True
                )
            if int(match.group(1)) > MAX_MAIL_MESSAGE_BYTES:
                raise MailGatewayError("email message exceeds the read limit")
            status, data = client.uid("fetch", clean_uid, "(BODY.PEEK[])")
            _imap_ok(status, operation="message read")
            raw = _response_bytes(data)
            if not raw:
                raise MailGatewayError("email message was not found")
            if len(raw) > MAX_MAIL_MESSAGE_BYTES:
                raise MailGatewayError("email message exceeds the read limit")
            return BytesParser(policy=policy.default).parsebytes(raw), _parse_flags(metadata)
        finally:
            self._close_imap(client)

    def read(
        self,
        account: dict[str, Any],
        password: str,
        *,
        folder: str,
        uid: int,
    ) -> dict[str, Any]:
        message, flags = self._fetch_message(
            account, password, folder=folder, uid=uid
        )
        return public_message(message, uid=normalize_uid(uid), flags=flags)

    def attachment(
        self,
        account: dict[str, Any],
        password: str,
        *,
        folder: str,
        uid: int,
        attachment_index: int,
    ) -> tuple[str, str, bytes]:
        message, _ = self._fetch_message(account, password, folder=folder, uid=uid)
        try:
            wanted = int(attachment_index)
        except (TypeError, ValueError) as exc:
            raise MailGatewayError("attachment index is invalid") from exc
        for index, part in enumerate(message.walk() if message.is_multipart() else (message,)):
            if index != wanted:
                continue
            filename = str(part.get_filename() or "").strip()
            disposition = (part.get_content_disposition() or "").casefold()
            if not filename and disposition != "attachment":
                break
            payload = part.get_payload(decode=True) or b""
            if len(payload) > MAX_MAIL_ATTACHMENT_BYTES:
                raise MailGatewayError("email attachment exceeds the save limit")
            return (
                filename[:512] or f"attachment-{wanted}",
                str(part.get_content_type() or "application/octet-stream")[:255],
                payload,
            )
        raise MailGatewayError("email attachment was not found")

    def search(
        self,
        account: dict[str, Any],
        password: str,
        *,
        folder: str,
        criteria: dict[str, Any],
        limit: int,
    ) -> list[dict[str, Any]]:
        client: imaplib.IMAP4 | None = None
        try:
            client = self._imap(account, password)
            status, _ = client.select(_quoted_mailbox(normalize_folder(folder)), readonly=True)
            _imap_ok(status, operation="mailbox selection")
            highest_uid = _selected_number(client, "UIDNEXT") - 1
            if highest_uid <= 0:
                return []
            first_uid = max(1, highest_uid - MAX_MAIL_UID_SCAN_SPAN + 1)
            tokens: list[str] = ["UID", f"{first_uid}:{highest_uid}"]
            if bool(criteria.get("unread")):
                tokens.append("UNSEEN")
            for key, token in (("from", "FROM"), ("to", "TO"), ("subject", "SUBJECT")):
                value = _safe_header(criteria.get(key), field=key, maximum=512)
                if value:
                    tokens.extend((token, '"' + value.replace('"', "") + '"'))
            for key, token in (("since", "SINCE"), ("before", "BEFORE")):
                raw = str(criteria.get(key) or "").strip()
                if raw:
                    try:
                        parsed = date.fromisoformat(raw)
                    except ValueError as exc:
                        raise MailGatewayError(f"{key} must use YYYY-MM-DD") from exc
                    tokens.extend((token, parsed.strftime("%d-%b-%Y")))
            status, data = client.uid("search", None, *tokens)
            _imap_ok(status, operation="mail search")
            uid_bytes = b" ".join(item for item in (data or []) if isinstance(item, bytes))
            all_uids = [int(item) for item in uid_bytes.split() if item.isdigit() and int(item) > 0]
            wanted = list(reversed(all_uids[-max(1, min(int(limit), MAX_MAIL_RESULTS)) :]))
            results: list[dict[str, Any]] = []
            for uid in wanted:
                status, fetched = client.uid(
                    "fetch",
                    str(uid),
                    "(BODY.PEEK[HEADER.FIELDS (DATE FROM TO CC SUBJECT MESSAGE-ID)] FLAGS)",
                )
                if str(status or "").upper() != "OK":
                    continue
                raw = _response_bytes(fetched)
                if not raw or len(raw) > 256 * 1024:
                    continue
                message = BytesParser(policy=policy.default).parsebytes(raw)
                results.append(
                    {
                        "uid": uid,
                        "message_id": str(message.get("Message-ID") or "")[:998],
                        "subject": str(message.get("Subject") or "")[:MAX_MAIL_SUBJECT_CHARACTERS],
                        "from": str(message.get("From") or "")[:2_000],
                        "to": str(message.get("To") or "")[:4_000],
                        "cc": str(message.get("Cc") or "")[:4_000],
                        "date": _message_date(message),
                        "flags": _parse_flags(fetched),
                    }
                )
            return results
        finally:
            self._close_imap(client)

    def move(
        self,
        account: dict[str, Any],
        password: str,
        *,
        folder: str,
        uid: int,
        destination: str,
    ) -> None:
        client: imaplib.IMAP4 | None = None
        try:
            client = self._imap(account, password)
            status, _ = client.select(_quoted_mailbox(normalize_folder(folder)), readonly=False)
            _imap_ok(status, operation="mailbox selection")
            status, _ = client.uid(
                "MOVE", str(normalize_uid(uid)), _quoted_mailbox(normalize_folder(destination))
            )
            # Require the server's atomic UID MOVE extension. A COPY followed
            # by STORE(\Deleted) has an ambiguous partial-success state: retry
            # can duplicate the destination message, while EXPUNGE would be
            # irreversible. Fail closed when atomic MOVE is unavailable.
            _imap_ok(status, operation="atomic message move")
        finally:
            self._close_imap(client)

    def mark(
        self,
        account: dict[str, Any],
        password: str,
        *,
        folder: str,
        uid: int,
        state: str,
    ) -> None:
        mapping = {
            "seen": ("+FLAGS.SILENT", "(\\Seen)"),
            "unseen": ("-FLAGS.SILENT", "(\\Seen)"),
            "flagged": ("+FLAGS.SILENT", "(\\Flagged)"),
            "unflagged": ("-FLAGS.SILENT", "(\\Flagged)"),
        }
        if state not in mapping:
            raise MailGatewayError("mail mark state is invalid")
        client: imaplib.IMAP4 | None = None
        try:
            client = self._imap(account, password)
            status, _ = client.select(_quoted_mailbox(normalize_folder(folder)), readonly=False)
            _imap_ok(status, operation="mailbox selection")
            operation, flags = mapping[state]
            status, _ = client.uid("STORE", str(normalize_uid(uid)), operation, flags)
            _imap_ok(status, operation="message flag update")
        finally:
            self._close_imap(client)

    def send(
        self,
        account: dict[str, Any],
        password: str,
        *,
        to: Any,
        cc: Any,
        bcc: Any,
        subject: Any,
        text_body: Any,
        html_body: Any = "",
        in_reply_to: str = "",
        references: str = "",
    ) -> dict[str, Any]:
        to_addresses = normalize_mail_addresses(to, field="to", required=True)
        cc_addresses = normalize_mail_addresses(cc, field="cc")
        bcc_addresses = normalize_mail_addresses(bcc, field="bcc")
        recipients = to_addresses + cc_addresses + bcc_addresses
        if len(recipients) > MAX_MAIL_RECIPIENTS:
            raise MailGatewayError("too many email recipients")
        clean_subject = _safe_header(subject, field="subject", maximum=MAX_MAIL_SUBJECT_CHARACTERS)
        text = str(text_body or "")
        html = str(html_body or "")
        if not text and not html:
            raise MailGatewayError("email body is required")
        if len(text) > MAX_MAIL_BODY_CHARACTERS or len(html) > MAX_MAIL_BODY_CHARACTERS * 4:
            raise MailGatewayError("email body is too long")

        message = EmailMessage(policy=policy.SMTP)
        message["From"] = _safe_header(
            account.get("email_address"), field="from", maximum=320
        )
        message["To"] = ", ".join(to_addresses)
        if cc_addresses:
            message["Cc"] = ", ".join(cc_addresses)
        message["Subject"] = clean_subject
        message["Date"] = formatdate(localtime=False)
        message_id = make_msgid()
        message["Message-ID"] = message_id
        if in_reply_to:
            message["In-Reply-To"] = _safe_header(
                in_reply_to, field="in_reply_to", maximum=998
            )
        if references:
            message["References"] = _safe_header(
                references, field="references", maximum=8_192
            )
        message.set_content(text or "This message contains an HTML body.")
        if html:
            message.add_alternative(html, subtype="html")

        client: smtplib.SMTP | None = None
        send_started = False
        try:
            client = self._smtp(account, password)
            send_started = True
            refused = client.send_message(message, to_addrs=recipients)
            if refused:
                # A non-empty refusal map means at least one recipient may
                # already have accepted the message. Blind retry could send a
                # duplicate to those recipients, so force human review.
                raise MailGatewayError(
                    "mail server refused one or more recipients",
                    uncertain=True,
                )
            return {"message_id": message_id, "recipients": len(recipients)}
        except MailGatewayError:
            raise
        except (smtplib.SMTPRecipientsRefused, smtplib.SMTPSenderRefused, smtplib.SMTPDataError) as exc:
            raise MailGatewayError(f"mail delivery was rejected: {type(exc).__name__}") from exc
        except smtplib.SMTPAuthenticationError as exc:
            raise MailGatewayError("SMTP authentication failed") from exc
        except (smtplib.SMTPServerDisconnected, socket.timeout, TimeoutError, OSError) as exc:
            raise MailGatewayError(
                "mail delivery transport disconnected",
                temporary=not send_started,
                uncertain=send_started,
            ) from exc
        except smtplib.SMTPException as exc:
            raise MailGatewayError(
                f"SMTP delivery failed: {type(exc).__name__}",
                uncertain=send_started,
            ) from exc
        finally:
            self._close_smtp(client)
