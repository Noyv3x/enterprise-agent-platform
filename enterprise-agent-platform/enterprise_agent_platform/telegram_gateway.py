from __future__ import annotations

import json
import mimetypes
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .service import EnterpriseService, ServiceError, UploadedFile


TELEGRAM_API_BASE = "https://api.telegram.org"
POLL_TIMEOUT_SECONDS = 30
SEND_CHUNK_SIZE = 3900
MAX_TELEGRAM_FILE_BYTES = 20 * 1024 * 1024


class TelegramBotAPI:
    def __init__(self, token: str, *, base_url: str = TELEGRAM_API_BASE):
        self.token = token
        self.base_url = base_url.rstrip("/")

    def call(self, method: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}/bot{self.token}/{method}",
            data=body,
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=POLL_TIMEOUT_SECONDS + 10) as response:
                data = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Telegram API {method} failed: HTTP {exc.code}: {detail}") from exc
        if not data.get("ok"):
            raise RuntimeError(f"Telegram API {method} failed: {data}")
        result = data.get("result")
        return result if isinstance(result, dict) else {"result": result}

    def get_updates(self, *, offset: int | None = None, timeout: int = POLL_TIMEOUT_SECONDS) -> list[dict[str, Any]]:
        payload: dict[str, Any] = {
            "timeout": timeout,
            "allowed_updates": ["message", "edited_message"],
        }
        if offset is not None:
            payload["offset"] = offset
        result = self.call("getUpdates", payload).get("result")
        return result if isinstance(result, list) else []

    def get_file(self, file_id: str) -> dict[str, Any]:
        return self.call("getFile", {"file_id": file_id})

    def download_file(self, file_path: str) -> bytes:
        quoted = urllib.parse.quote(str(file_path).lstrip("/"), safe="/")
        request = urllib.request.Request(f"{self.base_url}/file/bot{self.token}/{quoted}", method="GET")
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read(MAX_TELEGRAM_FILE_BYTES + 1)

    def send_message(
        self,
        *,
        chat_id: int | str,
        text: str,
        reply_to_message_id: int | None = None,
        message_thread_id: int | None = None,
    ) -> None:
        clean = str(text or "").strip() or "Agent returned an empty response."
        for chunk in _chunks(clean, SEND_CHUNK_SIZE):
            payload: dict[str, Any] = {
                "chat_id": chat_id,
                "text": chunk,
                "disable_web_page_preview": True,
            }
            if reply_to_message_id is not None:
                payload["reply_to_message_id"] = reply_to_message_id
                payload["allow_sending_without_reply"] = True
            if message_thread_id is not None:
                payload["message_thread_id"] = message_thread_id
            self.call("sendMessage", payload)

    def send_file(
        self,
        *,
        chat_id: int | str,
        path: str,
        filename: str,
        content_type: str,
        reply_to_message_id: int | None = None,
        message_thread_id: int | None = None,
    ) -> None:
        method = "sendPhoto" if str(content_type or "").lower().startswith("image/") else "sendDocument"
        field = "photo" if method == "sendPhoto" else "document"
        fields: dict[str, Any] = {"chat_id": chat_id}
        if reply_to_message_id is not None:
            fields["reply_to_message_id"] = reply_to_message_id
            fields["allow_sending_without_reply"] = "true"
        if message_thread_id is not None:
            fields["message_thread_id"] = message_thread_id
        with open(path, "rb") as fh:
            self._call_multipart(
                method,
                fields,
                {field: (filename, content_type or "application/octet-stream", fh.read())},
            )

    def _call_multipart(
        self,
        method: str,
        fields: dict[str, Any],
        files: dict[str, tuple[str, str, bytes]],
    ) -> dict[str, Any]:
        boundary = f"----enterprise-telegram-{int(time.time() * 1000)}"
        body = bytearray()
        for key, value in fields.items():
            body.extend(f"--{boundary}\r\n".encode("ascii"))
            body.extend(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode("utf-8"))
            body.extend(str(value).encode("utf-8"))
            body.extend(b"\r\n")
        for key, (filename, content_type, data) in files.items():
            safe_name = str(filename or "attachment").replace("\r", "_").replace("\n", "_").replace('"', "_")
            body.extend(f"--{boundary}\r\n".encode("ascii"))
            body.extend(
                f'Content-Disposition: form-data; name="{key}"; filename="{safe_name}"\r\n'.encode("utf-8")
            )
            body.extend(f"Content-Type: {content_type or 'application/octet-stream'}\r\n\r\n".encode("utf-8"))
            body.extend(data)
            body.extend(b"\r\n")
        body.extend(f"--{boundary}--\r\n".encode("ascii"))
        request = urllib.request.Request(
            f"{self.base_url}/bot{self.token}/{method}",
            data=bytes(body),
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            data = json.loads(response.read().decode("utf-8"))
        if not data.get("ok"):
            raise RuntimeError(f"Telegram API {method} failed: {data}")
        result = data.get("result")
        return result if isinstance(result, dict) else {"result": result}


class TelegramGateway:
    def __init__(
        self,
        service: EnterpriseService,
        *,
        bot: TelegramBotAPI | None = None,
        autostart: bool = True,
    ):
        self.service = service
        self.bot = bot or TelegramBotAPI(service.telegram_bot_token())
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._offset: int | None = None
        self._autostart = autostart

    def start(self) -> None:
        if not self._autostart or not self.service.telegram_polling_enabled():
            return
        if self._thread is not None and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._poll_loop, name="telegram-gateway", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3)

    def process_update(self, update: dict[str, Any]) -> dict[str, Any]:
        message = update.get("message") or update.get("edited_message")
        if not isinstance(message, dict):
            return {"ok": True, "ignored": "unsupported update"}
        if message.get("from", {}).get("is_bot"):
            return {"ok": True, "ignored": "bot message"}
        chat = message.get("chat") if isinstance(message.get("chat"), dict) else {}
        sender = message.get("from") if isinstance(message.get("from"), dict) else {}
        if not chat or not sender:
            return {"ok": True, "ignored": "empty message"}
        chat_type = str(chat.get("type") or "").lower()
        if chat_type != "private":
            return {"ok": True, "ignored": "non-private chat"}
        text = str(message.get("text") or message.get("caption") or "").strip()
        attachments, notes = self._attachments_for_message(message)
        if notes:
            text = (text + "\n\n" + "\n".join(notes)).strip()
        if not text and not attachments:
            return {"ok": True, "ignored": "empty message"}
        if text.startswith("/start") or text.startswith("/help"):
            self._send_reply(message, self._help_text(sender))
            return {"ok": True, "command": True}

        try:
            actor = self.service.telegram_actor_for_user(sender)
        except ServiceError:
            self._send_reply(message, self._unlinked_text(sender))
            return {"ok": True, "ignored": "unlinked telegram user"}
        return self._route_private(actor, message, text, attachments)

    def _route_private(
        self,
        actor: dict[str, Any],
        message: dict[str, Any],
        text: str,
        attachments: list[UploadedFile],
    ) -> dict[str, Any]:
        scope_id = str(actor["id"])
        after_id = self.service.latest_message_id("private", scope_id)
        result = self.service.send_private_message(actor, text, attachments)
        agent = self.service.wait_for_agent_message_after(
            "private",
            scope_id,
            after_id,
            timeout=self.service.config.hermes_timeout_seconds + 30,
        )
        if agent:
            self._send_agent_response(actor, message, agent)
        return {
            "ok": True,
            "scope_type": "private",
            "scope_id": scope_id,
            "user_message_id": result["user_message"]["id"],
            "agent_message_id": agent.get("id") if agent else None,
            "attachment_count": len(attachments),
        }

    def _attachments_for_message(self, message: dict[str, Any]) -> tuple[list[UploadedFile], list[str]]:
        descriptors = self._attachment_descriptors(message)
        attachments: list[UploadedFile] = []
        notes: list[str] = []
        for item in descriptors:
            file_id = str(item.get("file_id") or "")
            if not file_id:
                continue
            size = _int_or_none(item.get("file_size"))
            if size is None or size <= 0 or size > MAX_TELEGRAM_FILE_BYTES:
                notes.append(
                    f"[Telegram attachment skipped: {item.get('filename') or 'file'} exceeds the 20 MB Bot API download limit or has no verified size.]"
                )
                continue
            try:
                file_info = self.bot.get_file(file_id)
                data = self.bot.download_file(str(file_info.get("file_path") or ""))
            except Exception as exc:
                notes.append(f"[Telegram attachment could not be downloaded: {item.get('filename') or 'file'} ({exc}).]")
                continue
            if len(data) > MAX_TELEGRAM_FILE_BYTES:
                notes.append(f"[Telegram attachment skipped after download: {item.get('filename') or 'file'} is over 20 MB.]")
                continue
            filename = str(item.get("filename") or _filename_from_file_path(file_info.get("file_path")) or f"telegram-{file_id}")
            content_type = str(item.get("content_type") or mimetypes.guess_type(filename)[0] or "application/octet-stream")
            attachments.append(UploadedFile(filename=filename, content_type=content_type, data=data))
        return attachments, notes

    def _attachment_descriptors(self, message: dict[str, Any]) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        photos = message.get("photo")
        if isinstance(photos, list) and photos:
            best = max(
                (item for item in photos if isinstance(item, dict)),
                key=lambda item: int(item.get("file_size") or 0),
                default=None,
            )
            if best:
                result.append(
                    {
                        "file_id": best.get("file_id"),
                        "file_size": best.get("file_size"),
                        "filename": f"telegram-photo-{best.get('file_unique_id') or best.get('file_id')}.jpg",
                        "content_type": "image/jpeg",
                    }
                )
        for key, default_ext, default_type in (
            ("document", "bin", "application/octet-stream"),
            ("audio", "mp3", "audio/mpeg"),
            ("voice", "ogg", "audio/ogg"),
            ("video", "mp4", "video/mp4"),
            ("animation", "mp4", "video/mp4"),
        ):
            source = message.get(key)
            if not isinstance(source, dict):
                continue
            file_id = source.get("file_id")
            filename = source.get("file_name") or f"telegram-{key}-{source.get('file_unique_id') or file_id}.{default_ext}"
            result.append(
                {
                    "file_id": file_id,
                    "file_size": source.get("file_size"),
                    "filename": filename,
                    "content_type": source.get("mime_type") or default_type,
                }
            )
        return result

    def _help_text(self, sender: dict[str, Any]) -> str:
        return (
            "Telegram 私聊网关已连接。\n"
            f"你的 Telegram ID 是：{sender.get('id')}\n"
            "请在平台的「私人 Agent」页面绑定这个 ID。绑定后，私聊发送的消息会进入你自己的私人 Agent。"
        )

    def _unlinked_text(self, sender: dict[str, Any]) -> str:
        return (
            "这个 Telegram 账号还没有绑定到平台用户。\n"
            f"Telegram ID：{sender.get('id')}\n"
            "登录平台后打开「私人 Agent」，在 Telegram 绑定里保存这个 ID。"
        )

    def _send_reply(self, message: dict[str, Any], text: str) -> None:
        chat = message.get("chat") if isinstance(message.get("chat"), dict) else {}
        chat_id = chat.get("id")
        if chat_id is None:
            return
        try:
            self.bot.send_message(
                chat_id=chat_id,
                text=text,
                reply_to_message_id=_int_or_none(message.get("message_id")),
                message_thread_id=_int_or_none(message.get("message_thread_id")),
            )
        except Exception as exc:
            print(f"Failed to send Telegram reply: {exc}", file=sys.stderr)

    def _send_agent_response(self, actor: dict[str, Any], message: dict[str, Any], agent_message: dict[str, Any]) -> None:
        content = str(agent_message.get("content") or "").strip()
        if content:
            self._send_reply(message, content)
        for attachment in agent_message.get("attachments") or []:
            self._send_attachment(actor, message, attachment)

    def _send_attachment(self, actor: dict[str, Any], message: dict[str, Any], attachment: dict[str, Any]) -> None:
        chat = message.get("chat") if isinstance(message.get("chat"), dict) else {}
        chat_id = chat.get("id")
        if chat_id is None:
            return
        try:
            metadata, path = self.service.get_attachment_file(actor, int(attachment.get("id")))
            self.bot.send_file(
                chat_id=chat_id,
                path=str(path),
                filename=str(metadata.get("filename") or "attachment"),
                content_type=str(metadata.get("mime_type") or "application/octet-stream"),
                reply_to_message_id=_int_or_none(message.get("message_id")),
                message_thread_id=_int_or_none(message.get("message_thread_id")),
            )
        except Exception as exc:
            print(f"Failed to send Telegram attachment: {exc}", file=sys.stderr)

    def _poll_loop(self) -> None:
        while not self._stop.is_set():
            try:
                updates = self.bot.get_updates(offset=self._offset, timeout=POLL_TIMEOUT_SECONDS)
                for update in updates:
                    update_id = _int_or_none(update.get("update_id"))
                    if update_id is not None:
                        self._offset = update_id + 1
                    try:
                        self.process_update(update)
                    except ServiceError as exc:
                        print(f"Telegram gateway rejected update: {exc.message}", file=sys.stderr)
                    except Exception as exc:
                        print(f"Telegram gateway failed to process update: {exc}", file=sys.stderr)
            except Exception as exc:
                if not self._stop.is_set():
                    print(f"Telegram gateway polling failed: {exc}", file=sys.stderr)
                    self._stop.wait(5)


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _chunks(value: str, size: int) -> list[str]:
    text = str(value or "")
    if len(text) <= size:
        return [text]
    return [text[index : index + size] for index in range(0, len(text), size)]


def _filename_from_file_path(value: Any) -> str:
    path = str(value or "").strip()
    if not path:
        return ""
    return path.rsplit("/", 1)[-1]
