from __future__ import annotations

import os
import re
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SENSITIVE_RE = re.compile(
    r"(API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|TOKEN\b|SECRET|PASSWORD|CREDENTIAL|JWT)",
    re.IGNORECASE,
)
ENV_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,100}$")
_CONFIG_UPDATE_LOCK = threading.RLock()
_PRIVATE_CONFIG_MODE = 0o600


@dataclass(frozen=True)
class ConfigField:
    key: str
    label: str
    group: str
    kind: str = "text"
    description: str = ""
    options: tuple[str, ...] = ()
    secret: bool = False

    def to_dict(self, value: Any, *, configured: bool) -> dict[str, Any]:
        secret = self.secret or is_sensitive_key(self.key)
        return {
            "key": self.key,
            "label": self.label,
            "group": self.group,
            "kind": self.kind,
            "description": self.description,
            "options": list(self.options),
            "secret": secret,
            "configured": configured,
            "defaulted": False,
            "source": "configured" if configured else "unset",
            "value": "" if secret and configured else value,
            "masked": mask_value(str(value)) if secret and configured else "",
        }


COGNEE_ENV_FIELDS = (
    ConfigField("LLM_API_KEY", "LLM API Key", "LLM", secret=True),
    ConfigField("LLM_PROVIDER", "LLM 供应商", "LLM"),
    ConfigField("LLM_MODEL", "LLM 模型", "LLM"),
    ConfigField("LLM_ENDPOINT", "LLM Endpoint", "LLM"),
    ConfigField("LLM_API_VERSION", "LLM API Version", "LLM"),
    ConfigField("LLM_TEMPERATURE", "LLM Temperature", "LLM", "number"),
    ConfigField("LLM_STREAMING", "LLM Streaming", "LLM", "boolean"),
    ConfigField("LLM_MAX_COMPLETION_TOKENS", "LLM 最大生成 tokens", "LLM", "number"),
    ConfigField("STRUCTURED_OUTPUT_FRAMEWORK", "结构化输出框架", "LLM", "select", options=("instructor", "baml")),
    ConfigField("LLM_ARGS", "LLM 额外参数", "LLM", "json"),
    ConfigField("LLM_RATE_LIMIT_ENABLED", "LLM 限流", "LLM", "boolean"),
    ConfigField("LLM_RATE_LIMIT_REQUESTS", "LLM 限流请求数", "LLM", "number"),
    ConfigField("LLM_RATE_LIMIT_INTERVAL", "LLM 限流窗口秒数", "LLM", "number"),
    ConfigField("EMBEDDING_PROVIDER", "Embedding 供应商", "Embedding"),
    ConfigField("EMBEDDING_MODEL", "Embedding 模型", "Embedding"),
    ConfigField("EMBEDDING_ENDPOINT", "Embedding Endpoint", "Embedding"),
    ConfigField("EMBEDDING_DIMENSIONS", "Embedding 维度", "Embedding", "number"),
    ConfigField("EMBEDDING_MAX_TOKENS", "Embedding 最大 tokens", "Embedding", "number"),
    ConfigField("EMBEDDING_BATCH_SIZE", "Embedding 批大小", "Embedding", "number"),
    ConfigField("EMBEDDING_API_KEY", "Embedding API Key", "Embedding", secret=True),
    ConfigField("DATA_ROOT_DIRECTORY", "数据根目录", "目录"),
    ConfigField("SYSTEM_ROOT_DIRECTORY", "系统根目录", "目录"),
    ConfigField("CACHE_ROOT_DIRECTORY", "缓存根目录", "目录"),
    ConfigField("COGNEE_LOGS_DIR", "日志目录", "目录"),
    ConfigField("STORAGE_BACKEND", "存储后端", "存储", "select", options=("local", "s3")),
    ConfigField("STORAGE_BUCKET_NAME", "S3 Bucket", "存储"),
    ConfigField("AWS_REGION", "AWS Region", "存储"),
    ConfigField("AWS_ACCESS_KEY_ID", "AWS Access Key ID", "存储", secret=True),
    ConfigField("AWS_SECRET_ACCESS_KEY", "AWS Secret Access Key", "存储", secret=True),
    ConfigField("DB_PROVIDER", "关系数据库供应商", "数据库", "select", options=("sqlite", "postgres")),
    ConfigField("DB_HOST", "DB Host", "数据库"),
    ConfigField("DB_PORT", "DB Port", "数据库", "number"),
    ConfigField("DB_USERNAME", "DB Username", "数据库"),
    ConfigField("DB_PASSWORD", "DB Password", "数据库", secret=True),
    ConfigField("DB_NAME", "DB Name", "数据库"),
    ConfigField("DATABASE_CONNECT_ARGS", "数据库连接参数", "数据库", "json"),
    ConfigField("POOL_ARGS", "数据库连接池参数", "数据库", "json"),
    ConfigField("GRAPH_DATABASE_PROVIDER", "图数据库供应商", "图数据库"),
    ConfigField("GRAPH_DATASET_DATABASE_HANDLER", "图数据库 dataset handler", "图数据库"),
    ConfigField("GRAPH_DATABASE_URL", "图数据库 URL", "图数据库"),
    ConfigField("GRAPH_DATABASE_NAME", "图数据库名称", "图数据库"),
    ConfigField("GRAPH_DATABASE_USERNAME", "图数据库用户名", "图数据库"),
    ConfigField("GRAPH_DATABASE_PASSWORD", "图数据库密码", "图数据库", secret=True),
    ConfigField("VECTOR_DB_PROVIDER", "向量数据库供应商", "向量数据库"),
    ConfigField("VECTOR_DATASET_DATABASE_HANDLER", "向量数据库 dataset handler", "向量数据库"),
    ConfigField("VECTOR_DB_URL", "向量数据库 URL", "向量数据库"),
    ConfigField("VECTOR_DB_KEY", "向量数据库 Key", "向量数据库", secret=True),
    ConfigField("ONTOLOGY_RESOLVER", "Ontology Resolver", "Ontology"),
    ConfigField("MATCHING_STRATEGY", "Ontology 匹配策略", "Ontology"),
    ConfigField("ONTOLOGY_FILE_PATH", "Ontology 文件路径", "Ontology"),
    ConfigField("TRANSLATION_PROVIDER", "翻译供应商", "翻译"),
    ConfigField("TARGET_LANGUAGE", "目标语言", "翻译"),
    ConfigField("CONFIDENCE_THRESHOLD", "翻译置信阈值", "翻译", "number"),
    ConfigField("ENABLE_BACKEND_ACCESS_CONTROL", "后端访问控制", "安全", "boolean"),
    ConfigField("REQUIRE_AUTHENTICATION", "强制认证", "安全", "boolean"),
    ConfigField("HASH_API_KEY", "API Key 哈希存储", "安全", "boolean"),
    ConfigField("ACCEPT_LOCAL_FILE_PATH", "允许本地文件路径", "安全", "boolean"),
    ConfigField("ALLOW_HTTP_REQUESTS", "允许 HTTP 请求", "安全", "boolean"),
    ConfigField("ALLOW_CYPHER_QUERY", "允许 Cypher 查询", "安全", "boolean"),
    ConfigField("RAISE_INCREMENTAL_LOADING_ERRORS", "增量加载错误抛出", "安全", "boolean"),
    ConfigField("WEB_SCRAPER_TIMEOUT", "网页抓取超时", "Web Scraper", "number"),
    ConfigField("WEB_SCRAPER_MAX_DELAY", "网页抓取最大延迟", "Web Scraper", "number"),
    ConfigField("COGNEE_TRACING_ENABLED", "OpenTelemetry tracing", "可观测性", "boolean"),
    ConfigField("OTEL_SERVICE_NAME", "OTEL Service Name", "可观测性"),
    ConfigField("OTEL_EXPORTER_OTLP_ENDPOINT", "OTLP Endpoint", "可观测性"),
    ConfigField("LOG_LEVEL", "日志等级", "可观测性", "select", options=("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")),
    ConfigField("COGNEE_LOG_FILE", "写入日志文件", "可观测性", "boolean"),
    ConfigField("COGNEE_LOG_MAX_BYTES", "单个日志文件上限", "可观测性", "number"),
    ConfigField("COGNEE_LOG_BACKUP_COUNT", "日志保留文件数", "可观测性", "number"),
)


def read_cognee_internal_config(
    env_path: Path,
    effective_env: dict[str, str] | None = None,
) -> dict[str, Any]:
    env_values = dict(effective_env or {})
    env_values.update(read_env_file(env_path))
    return {
        "env_path": str(env_path),
        "env": fields_from_env(COGNEE_ENV_FIELDS, env_values),
    }


def fields_from_env(
    fields: tuple[ConfigField, ...],
    values: dict[str, str],
) -> list[dict[str, Any]]:
    return [
        field.to_dict(
            values.get(field.key, ""),
            configured=field.key in values and values[field.key] != "",
        )
        for field in fields
    ]


def update_env_file(env_path: Path, updates: dict[str, Any]) -> None:
    with _CONFIG_UPDATE_LOCK:
        values = read_env_file(env_path)
        for key, value in updates.items():
            clean = str(key).strip().upper()
            if not ENV_KEY_RE.fullmatch(clean):
                raise ValueError(f"invalid env key: {key}")
            if value is None:
                values.pop(clean, None)
            else:
                values[clean] = str(value)
        _write_env_file_locked(env_path, values)


def is_sensitive_key(key: str) -> bool:
    return bool(SENSITIVE_RE.search(key))


def mask_value(value: str) -> str:
    if not value:
        return ""
    if len(value) < 12:
        return "********"
    return f"...{value[-4:]}"


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        clean = key.strip().upper()
        if ENV_KEY_RE.fullmatch(clean):
            values[clean] = unquote_env(value.strip())
    return values


def write_env_file(path: Path, values: dict[str, str]) -> None:
    with _CONFIG_UPDATE_LOCK:
        _write_env_file_locked(path, values)


def _write_env_file_locked(path: Path, values: dict[str, str]) -> None:
    lines = [
        f"{key}={quote_env(value)}"
        for key, value in sorted(values.items())
        if ENV_KEY_RE.fullmatch(key)
    ]
    _atomic_write_text(path, "\n".join(lines) + ("\n" if lines else ""))


def _atomic_write_text(
    path: Path,
    text: str,
    *,
    mode: int = _PRIVATE_CONFIG_MODE,
) -> None:
    target = path.expanduser()
    target.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.tmp-",
        dir=str(target.parent),
    )
    temporary = Path(temporary_name)
    open_fd = fd
    try:
        os.fchmod(open_fd, mode)
        handle = os.fdopen(open_fd, "w", encoding="utf-8")
        open_fd = -1
        with handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    except BaseException:
        if open_fd >= 0:
            try:
                os.close(open_fd)
            except OSError:
                pass
        try:
            temporary.unlink()
        except OSError:
            pass
        raise


def quote_env(value: str) -> str:
    safe = str(value).replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')
    return f'"{safe}"'


def unquote_env(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] == '"':
        return value[1:-1].replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1]
    return value
