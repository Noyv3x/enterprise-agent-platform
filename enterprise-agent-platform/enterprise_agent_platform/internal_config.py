from __future__ import annotations

import copy
import importlib.util
import json
import os
import re
import sys
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any


# Match secret-bearing key names. TOKEN carries a trailing word boundary so it
# matches real credential keys (auth_token, agent_token, "token") but NOT
# non-secret keys that merely start with the substring (max_tokens, tokenizer,
# token_count would otherwise be wrongly redacted/corrupted on a config round-trip).
SENSITIVE_RE = re.compile(
    r"(API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|TOKEN\b|SECRET|PASSWORD|CREDENTIAL|JWT)",
    re.IGNORECASE,
)
ENV_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,100}$")

# Placeholder written in place of inline secrets when redacting the raw
# config.yaml dump. On save, any value still equal to this placeholder is
# re-injected from the on-disk config so a redacted round-trip never clobbers
# the real credential.
REDACTED_PLACEHOLDER = "__REDACTED__"

# Config writes are rare administrative operations, so one process-wide
# re-entrant lock is preferable to a path-lock registry that can grow without
# bound.  The lock covers each complete read/modify/write transaction: atomic
# replace alone prevents torn reads, but without this lock two concurrent field
# updates can both read the same old file and silently discard one another.
_CONFIG_UPDATE_LOCK = threading.RLock()
_PRIVATE_CONFIG_MODE = 0o600

# Top-level YAML keys whose nested values legitimately carry inline secrets
# (e.g. providers/auxiliary/delegation blocks define `api_key`). Their JSON
# field renders and the raw yaml_text dump must be deep-redacted.
SECRET_BEARING_KEYS = ("providers", "fallback_providers", "auxiliary", "delegation")


@dataclass(frozen=True)
class ConfigField:
    key: str
    label: str
    group: str
    kind: str = "text"
    description: str = ""
    options: tuple[str, ...] = ()
    secret: bool = False

    def to_dict(self, value: Any, *, configured: bool, defaulted: bool = False) -> dict[str, Any]:
        secret = self.secret or is_sensitive_key(self.key)
        # Structured (e.g. JSON) values such as `providers`/`fallback_providers`
        # legitimately embed inline `api_key` secrets that the key-level
        # `secret` flag does not catch. Replace any nested sensitive subkey with
        # the redaction placeholder before serializing so plaintext keys never
        # reach the client; the placeholder is restored from disk on save.
        rendered = value if secret and configured else redact_sensitive(value, REDACTED_PLACEHOLDER)
        return {
            "key": self.key,
            "label": self.label,
            "group": self.group,
            "kind": self.kind,
            "description": self.description,
            "options": list(self.options),
            "secret": secret,
            "configured": configured,
            "defaulted": bool(defaulted and not configured),
            "source": "configured" if configured else ("default" if defaulted else "unset"),
            "value": "" if secret and configured else value_for_json(rendered),
            "masked": mask_value(str(value)) if secret and configured else "",
        }


HERMES_YAML_FIELDS = (
    ConfigField("model.default", "默认模型", "模型"),
    ConfigField("model.provider", "模型供应商", "模型"),
    ConfigField("model.base_url", "模型 Base URL", "模型"),
    ConfigField("model.context_length", "上下文长度", "模型", "number"),
    ConfigField("providers", "自定义供应商", "模型", "json"),
    ConfigField("fallback_providers", "供应商 fallback 链", "模型", "json"),
    ConfigField("toolsets", "启用工具集", "工具", "json"),
    ConfigField("agent.disabled_toolsets", "禁用工具集", "工具", "json"),
    ConfigField("tool_output.max_bytes", "工具输出字符上限", "工具", "number"),
    ConfigField("tool_output.max_lines", "文件读取行数上限", "工具", "number"),
    ConfigField("agent.max_turns", "Agent 最大回合", "Agent", "number"),
    ConfigField("agent.api_max_retries", "API 最大重试", "Agent", "number"),
    ConfigField("agent.gateway_timeout", "Gateway 空闲超时秒数", "Agent", "number"),
    ConfigField("agent.gateway_timeout_warning", "超时警告秒数", "Agent", "number"),
    ConfigField("agent.gateway_notify_interval", "仍在工作提示间隔", "Agent", "number"),
    ConfigField("agent.image_input_mode", "图片输入模式", "Agent", "select", options=("auto", "native", "text")),
    ConfigField("terminal.timeout", "终端命令超时", "终端", "number"),
    ConfigField("terminal.env_passthrough", "透传环境变量", "终端", "json"),
    ConfigField("terminal.shell_init_files", "Shell 初始化文件", "终端", "json"),
    ConfigField("compression.enabled", "上下文压缩", "上下文", "boolean"),
    ConfigField("compression.threshold", "压缩触发阈值", "上下文", "number"),
    ConfigField("compression.target_ratio", "压缩目标比例", "上下文", "number"),
    ConfigField("compression.protect_last_n", "保留最近消息数", "上下文", "number"),
    ConfigField("compression.abort_on_summary_failure", "摘要失败时中止压缩", "上下文", "boolean"),
    ConfigField("prompt_caching.cache_ttl", "Prompt 缓存 TTL", "上下文", "select", options=("5m", "1h")),
    ConfigField("auxiliary.vision.provider", "视觉辅助供应商", "辅助模型"),
    ConfigField("auxiliary.vision.model", "视觉辅助模型", "辅助模型"),
    ConfigField("auxiliary.vision.timeout", "视觉辅助超时", "辅助模型", "number"),
    ConfigField("auxiliary.compression.provider", "压缩辅助供应商", "辅助模型"),
    ConfigField("auxiliary.compression.model", "压缩辅助模型", "辅助模型"),
    ConfigField("auxiliary.compression.timeout", "压缩辅助超时", "辅助模型", "number"),
    ConfigField("auxiliary.approval.provider", "审批辅助供应商", "辅助模型"),
    ConfigField("auxiliary.approval.model", "审批辅助模型", "辅助模型"),
    ConfigField("display.compact", "紧凑显示", "显示", "boolean"),
    ConfigField("display.show_reasoning", "显示推理", "显示", "boolean"),
    ConfigField("display.streaming", "流式显示", "显示", "boolean"),
    ConfigField("display.timestamps", "显示时间戳", "显示", "boolean"),
    ConfigField("display.final_response_markdown", "最终回复 Markdown", "显示", "select", options=("render", "strip", "raw")),
    ConfigField("display.inline_diffs", "显示内联 diff", "显示", "boolean"),
    ConfigField("display.tool_progress_mode", "工具进度显示", "显示", "select", options=("all", "minimal", "off")),
    ConfigField("stt.enabled", "语音转文字", "语音", "boolean"),
    ConfigField("stt.provider", "STT 供应商", "语音", "select", options=("local", "groq", "openai", "mistral")),
    ConfigField("stt.local.model", "本地 STT 模型", "语音"),
    ConfigField("memory.memory_enabled", "长期记忆", "记忆", "boolean"),
    ConfigField("memory.user_profile_enabled", "用户画像记忆", "记忆", "boolean"),
    ConfigField("memory.provider", "外部记忆供应商", "记忆"),
    ConfigField("delegation.provider", "子 Agent 供应商", "多 Agent"),
    ConfigField("delegation.model", "子 Agent 模型", "多 Agent"),
    ConfigField("delegation.max_iterations", "子 Agent 最大迭代", "多 Agent", "number"),
    ConfigField("delegation.child_timeout_seconds", "子 Agent 超时秒数", "多 Agent", "number"),
    ConfigField("approvals.mode", "危险操作审批模式", "安全", "select", options=("manual", "smart", "off")),
    ConfigField("approvals.timeout", "审批超时秒数", "安全", "number"),
    ConfigField("approvals.cron_mode", "Cron 审批模式", "安全", "select", options=("deny", "approve")),
    ConfigField("security.redact_secrets", "输出脱敏", "安全", "boolean"),
    ConfigField("security.tirith_enabled", "启用 Tirith 扫描", "安全", "boolean"),
    ConfigField("security.allow_private_urls", "允许访问私有 URL", "安全", "boolean"),
    ConfigField("plugins.enabled", "启用插件", "插件", "json"),
    ConfigField("hooks", "Shell hooks", "插件", "json"),
    ConfigField("cron.max_parallel_jobs", "Cron 并发任务数", "自动化", "number"),
    ConfigField("kanban.dispatch_in_gateway", "Gateway 内派发看板任务", "自动化", "boolean"),
    ConfigField("kanban.dispatch_interval_seconds", "看板派发间隔", "自动化", "number"),
    ConfigField("kanban.failure_limit", "看板失败阈值", "自动化", "number"),
)

HERMES_ENV_FIELDS = (
    ConfigField("API_SERVER_ENABLED", "API Server 开关", "Gateway", "boolean"),
    ConfigField("API_SERVER_HOST", "API Server Host", "Gateway"),
    ConfigField("API_SERVER_PORT", "API Server Port", "Gateway", "number"),
    ConfigField("API_SERVER_MODEL_NAME", "API Server 模型名", "Gateway"),
    ConfigField("API_SERVER_KEY", "API Server Key", "Gateway", secret=True),
    ConfigField("HERMES_INFERENCE_PROVIDER", "推理供应商", "模型"),
    ConfigField("HERMES_CODEX_BASE_URL", "Codex Base URL", "模型"),
    ConfigField("HERMES_XAI_BASE_URL", "Grok Base URL", "模型"),
    ConfigField("OPENROUTER_API_KEY", "OpenRouter API Key", "供应商密钥", secret=True),
    ConfigField("GOOGLE_API_KEY", "Google API Key", "供应商密钥", secret=True),
    ConfigField("EXA_API_KEY", "Exa API Key", "工具密钥", secret=True),
    ConfigField("FIRECRAWL_API_KEY", "Firecrawl API Key", "工具密钥", secret=True),
    ConfigField("FIRECRAWL_API_URL", "Firecrawl API URL", "工具"),
    ConfigField("CAMOFOX_URL", "Camofox URL", "浏览器"),
    ConfigField("TERMINAL_TIMEOUT", "终端超时覆盖", "终端", "number"),
    ConfigField("TERMINAL_LIFETIME_SECONDS", "终端环境生命周期", "终端", "number"),
    ConfigField("HERMES_ACCEPT_HOOKS", "自动接受 hooks", "插件", "boolean"),
    ConfigField("HERMES_MAX_ITERATIONS", "最大迭代覆盖", "Agent", "number"),
    ConfigField("HERMES_AGENT_TIMEOUT", "Agent 超时覆盖", "Agent", "number"),
    ConfigField("HERMES_TOOL_PROGRESS_MODE", "工具进度显示覆盖", "显示"),
)

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


def read_hermes_internal_config(
    config_path: Path,
    env_path: Path,
    default_config: dict[str, Any] | None = None,
    default_error: str = "",
) -> dict[str, Any]:
    mapping, yaml_text, error = read_yaml_mapping_with_text(config_path)
    env_values = read_env_file(env_path)
    return {
        "config_path": str(config_path),
        "env_path": str(env_path),
        "yaml_text": redact_yaml_text(mapping, yaml_text) if not error else yaml_text,
        "yaml_error": error,
        "default_error": default_error,
        "sections": summarize_mapping(mapping),
        "fields": fields_from_mapping(HERMES_YAML_FIELDS, mapping, default_config or {}),
        "env": fields_from_env(HERMES_ENV_FIELDS, env_values),
    }


def redact_yaml_text(mapping: dict[str, Any], yaml_text: str) -> str:
    """Return the raw config dump with inline secrets replaced by a recognizable
    placeholder. The mapping is re-serialized only when it actually contains a
    sensitive nested value, so secret-free configs keep their original
    formatting/comments untouched.
    """

    if not yaml_text.strip() or not mapping:
        return yaml_text
    redacted = redact_sensitive(mapping, REDACTED_PLACEHOLDER)
    if redacted == mapping:
        return yaml_text
    try:
        import yaml
    except Exception:
        # Without PyYAML we cannot safely re-serialize; fail closed by not
        # shipping the raw text rather than leaking unredacted secrets.
        return ""
    return yaml.safe_dump(redacted, sort_keys=False, allow_unicode=True)


def read_cognee_internal_config(env_path: Path, effective_env: dict[str, str] | None = None) -> dict[str, Any]:
    env_values = dict(effective_env or {})
    env_values.update(read_env_file(env_path))
    return {
        "env_path": str(env_path),
        "env": fields_from_env(COGNEE_ENV_FIELDS, env_values),
    }


def update_yaml_text(config_path: Path, yaml_text: str) -> None:
    with _CONFIG_UPDATE_LOCK:
        incoming = validate_yaml_mapping(yaml_text)
        rendered = yaml_text.rstrip() + "\n"
        # If the submitted text still carries the redaction placeholder (the raw
        # dump is masked on read), re-inject the real on-disk secrets so a redacted
        # round-trip never overwrites credentials with the placeholder. Reading
        # while holding the same lock as field updates makes this restoration and
        # the following replace one indivisible config transaction.
        if REDACTED_PLACEHOLDER in yaml_text:
            on_disk, _text, error = read_yaml_mapping_with_text(config_path)
            if not error:
                merged = restore_redacted_secrets(incoming, on_disk)
                try:
                    import yaml
                except Exception as exc:
                    raise ValueError("PyYAML is required to edit YAML config") from exc
                rendered = yaml.safe_dump(merged, sort_keys=False, allow_unicode=True)
        _atomic_write_text(config_path, rendered)


def update_yaml_values(config_path: Path, updates: dict[str, Any]) -> None:
    with _CONFIG_UPDATE_LOCK:
        mapping, _text, error = read_yaml_mapping_with_text(config_path)
        if error:
            raise ValueError(f"fix YAML before editing fields: {error}")
        fields = {field.key: field for field in HERMES_YAML_FIELDS}
        for key, value in updates.items():
            field = fields.get(str(key))
            if not field:
                raise ValueError(f"unsupported config key: {key}")
            is_empty = value is None or (isinstance(value, str) and value.strip() == "")
            if is_empty:
                # Clearing a field means "unset / fall back to the runtime default",
                # not "persist 0 / empty". Removing the key lets Hermes use its own
                # default instead of writing a semantically different literal value.
                delete_nested(mapping, field.key)
            else:
                coerced = coerce_field_value(field, value)
                # Structured fields are rendered with inline secrets redacted to the
                # placeholder; re-inject the on-disk secret when a placeholder comes
                # back so editing a provider block never wipes its `api_key`.
                if field.kind == "json" and isinstance(coerced, (dict, list)):
                    _found, on_disk_value = get_nested(mapping, field.key)
                    coerced = restore_redacted_secrets(coerced, on_disk_value if _found else None)
                set_nested(mapping, field.key, coerced)
        try:
            import yaml
        except Exception as exc:
            raise ValueError("PyYAML is required to edit YAML config") from exc
        _atomic_write_text(
            config_path,
            yaml.safe_dump(mapping, sort_keys=False, allow_unicode=True),
        )


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


def read_yaml_mapping_with_text(path: Path) -> tuple[dict[str, Any], str, str]:
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    if not text.strip():
        return {}, text, ""
    try:
        data = validate_yaml_mapping(text)
    except Exception as exc:
        return {}, text, str(exc)
    return data, text, ""


def validate_yaml_mapping(text: str) -> dict[str, Any]:
    try:
        import yaml
    except Exception as exc:
        raise ValueError("PyYAML is required to edit YAML config") from exc
    try:
        loaded = yaml.safe_load(text) if text.strip() else {}
    except Exception as exc:
        raise ValueError(str(exc)) from exc
    if loaded is None:
        return {}
    if not isinstance(loaded, dict):
        raise ValueError("config YAML must be a mapping at the top level")
    return loaded


def summarize_mapping(mapping: dict[str, Any]) -> list[dict[str, Any]]:
    sections = []
    for key, value in sorted(mapping.items()):
        if isinstance(value, dict):
            detail = f"{len(value)} keys"
            kind = "object"
        elif isinstance(value, list):
            detail = f"{len(value)} items"
            kind = "list"
        else:
            detail = str(value)
            kind = type(value).__name__
        sections.append({"key": key, "kind": kind, "detail": detail[:120]})
    return sections


def fields_from_mapping(
    fields: tuple[ConfigField, ...],
    mapping: dict[str, Any],
    default_mapping: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    result = []
    defaults = default_mapping or {}
    for field in fields:
        found, value = get_nested(mapping, field.key)
        configured = found and is_configured_value(value)
        if configured:
            result.append(field.to_dict(value, configured=True))
            continue
        default_found, default_value = get_default_value(defaults, field.key)
        defaulted = default_found and is_configured_value(default_value)
        result.append(field.to_dict(default_value if defaulted else "", configured=False, defaulted=defaulted))
    return result


def fields_from_env(fields: tuple[ConfigField, ...], values: dict[str, str]) -> list[dict[str, Any]]:
    result = []
    for field in fields:
        found = field.key in values and values[field.key] != ""
        result.append(field.to_dict(values.get(field.key, ""), configured=found))
    return result


def get_nested(mapping: dict[str, Any], path: str) -> tuple[bool, Any]:
    current: Any = mapping
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return False, None
        current = current[part]
    return True, current


def get_default_value(mapping: dict[str, Any], path: str) -> tuple[bool, Any]:
    found, value = get_nested(mapping, path)
    if found:
        return True, value
    # Hermes historically allowed the primary model to be a scalar at
    # DEFAULT_CONFIG["model"], while platform editing exposes the normalized
    # config.yaml shape as model.default.
    if path == "model.default":
        found, value = get_nested(mapping, "model")
        if found and not isinstance(value, dict):
            return True, value
    return False, None


def set_nested(mapping: dict[str, Any], path: str, value: Any) -> None:
    current: dict[str, Any] = mapping
    parts = path.split(".")
    for part in parts[:-1]:
        existing = current.get(part)
        if not isinstance(existing, dict):
            existing = {}
            current[part] = existing
        current = existing
    current[parts[-1]] = value


def delete_nested(mapping: dict[str, Any], path: str) -> None:
    parts = path.split(".")
    # Walk to the parent of the leaf, tracking the chain so we can prune
    # now-empty intermediate dicts after removing the leaf.
    chain: list[tuple[dict[str, Any], str]] = []
    current: Any = mapping
    for part in parts[:-1]:
        if not isinstance(current, dict) or part not in current:
            return
        chain.append((current, part))
        current = current[part]
    if not isinstance(current, dict):
        return
    current.pop(parts[-1], None)
    for parent, part in reversed(chain):
        child = parent.get(part)
        if isinstance(child, dict) and not child:
            parent.pop(part, None)
        else:
            break


def coerce_field_value(field: ConfigField, value: Any) -> Any:
    if value is None:
        return ""
    if field.kind == "boolean":
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in {"1", "true", "yes", "on"}
    if field.kind == "number":
        text = str(value).strip()
        if text == "":
            return 0
        try:
            number = float(text)
        except ValueError as exc:
            raise ValueError(f"{field.key} must be a number") from exc
        return int(number) if number.is_integer() else number
    if field.kind == "json":
        if isinstance(value, (dict, list)):
            return value
        text = str(value).strip()
        if not text:
            return [] if field.key in {
                "toolsets",
                "agent.disabled_toolsets",
                "fallback_providers",
                "plugins.enabled",
                "terminal.env_passthrough",
                "terminal.shell_init_files",
            } else {}
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{field.key} must be valid JSON") from exc
    return str(value)


def value_for_json(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return json.dumps(value, ensure_ascii=False, indent=2)


def is_configured_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return value != ""
    return True


_HERMES_DEFAULT_CONFIG_CACHE: dict[str, tuple[tuple[int, int], dict[str, Any]]] = {}


def load_hermes_default_config(repo_path: Path) -> tuple[dict[str, Any], str]:
    """Load Hermes' upstream DEFAULT_CONFIG from an adjacent source checkout.

    This imports only the configured Hermes source tree and returns a deep copy
    of DEFAULT_CONFIG. Importing is used instead of AST literal evaluation
    because Hermes' default dictionary contains a few computed values.
    """

    config_py = repo_path.expanduser() / "hermes_cli" / "config.py"
    try:
        stat = config_py.stat()
    except OSError as exc:
        return {}, f"Hermes default config not found: {config_py} ({exc})"
    cache_key = str(config_py.resolve())
    signature = (stat.st_mtime_ns, stat.st_size)
    cached = _HERMES_DEFAULT_CONFIG_CACHE.get(cache_key)
    if cached and cached[0] == signature:
        return copy.deepcopy(cached[1]), ""
    module_name = f"_enterprise_hermes_defaults_{abs(hash(cache_key))}"
    spec = importlib.util.spec_from_file_location(module_name, config_py)
    if spec is None or spec.loader is None:
        return {}, f"Unable to load Hermes default config from {config_py}"
    module = importlib.util.module_from_spec(spec)
    repo = str(repo_path.expanduser().resolve())
    inserted = False
    if repo not in sys.path:
        sys.path.insert(0, repo)
        inserted = True
    try:
        spec.loader.exec_module(module)
        defaults = getattr(module, "DEFAULT_CONFIG", None)
        if not isinstance(defaults, dict):
            return {}, f"Hermes DEFAULT_CONFIG is unavailable in {config_py}"
        clean = copy.deepcopy(defaults)
        _HERMES_DEFAULT_CONFIG_CACHE[cache_key] = (signature, clean)
        return copy.deepcopy(clean), ""
    except Exception as exc:
        return {}, f"Failed to read Hermes default config: {exc}"
    finally:
        if inserted:
            try:
                sys.path.remove(repo)
            except ValueError:
                pass


def is_sensitive_key(key: str) -> bool:
    return bool(SENSITIVE_RE.search(key))


def redact_sensitive(value: Any, replacement) -> Any:
    """Return a deep copy of *value* with any nested mapping entry whose key
    matches SENSITIVE_RE replaced.

    ``replacement`` may be a constant string or a callable taking the original
    value and returning its redacted form. Lists are walked element-wise so
    secrets nested in e.g. ``fallback_providers`` are also covered.
    """

    if isinstance(value, dict):
        result: dict[Any, Any] = {}
        for key, item in value.items():
            if isinstance(key, str) and is_sensitive_key(key) and not isinstance(item, (dict, list)):
                if item in (None, ""):
                    result[key] = item
                else:
                    result[key] = replacement(item) if callable(replacement) else replacement
            else:
                result[key] = redact_sensitive(item, replacement)
        return result
    if isinstance(value, list):
        return [redact_sensitive(item, replacement) for item in value]
    return value


def restore_redacted_secrets(incoming: Any, original: Any) -> Any:
    """Walk *incoming* and, wherever a sensitive leaf still holds the redaction
    placeholder, substitute the corresponding value from *original* (the
    on-disk config). Prevents a redacted GET/POST round-trip from clobbering
    real inline credentials with the placeholder.
    """

    if isinstance(incoming, dict):
        original_map = original if isinstance(original, dict) else {}
        result: dict[Any, Any] = {}
        for key, item in incoming.items():
            orig_item = original_map.get(key)
            if (
                isinstance(key, str)
                and is_sensitive_key(key)
                and isinstance(item, str)
                and item == REDACTED_PLACEHOLDER
            ):
                # The placeholder must be backed by a real saved secret. If the
                # key has no scalar value on disk (e.g. it was renamed, or the
                # structure changed) we must NOT silently substitute "" — that
                # would wipe the credential. Fail closed so the admin re-enters it.
                if isinstance(orig_item, str) and orig_item not in ("", REDACTED_PLACEHOLDER):
                    result[key] = orig_item
                else:
                    raise ValueError(
                        f"cannot restore the redacted secret for '{key}': it has no saved "
                        f"value (the field may have been renamed or reordered). Re-enter the "
                        f"real secret value instead of submitting the placeholder."
                    )
            else:
                result[key] = restore_redacted_secrets(item, orig_item)
        return result
    if isinstance(incoming, list):
        original_list = original if isinstance(original, list) else []
        # Match by stable identity (the element's non-secret fields) rather than
        # by list index, so reordering or resizing a list (e.g. fallback_providers)
        # never restores a secret onto the wrong entry. Each original element is
        # consumed at most once; an unmatched element gets no original, so any
        # placeholder inside it fails closed in the dict branch above.
        remaining = list(original_list)
        result_list = []
        for index, item in enumerate(incoming):
            sig = _redaction_identity(item)
            orig_item = None
            for pos, candidate in enumerate(remaining):
                if _redaction_identity(candidate) == sig:
                    orig_item = remaining.pop(pos)
                    break
            if orig_item is None and index < len(original_list):
                # Fall back to positional only when signatures also agree, so an
                # in-place edit of a non-secret field still restores its secret.
                positional = original_list[index]
                if _redaction_identity(positional) == sig and positional in remaining:
                    orig_item = positional
                    remaining.remove(positional)
            result_list.append(restore_redacted_secrets(item, orig_item))
        return result_list
    return incoming


def _redaction_identity(value: Any) -> Any:
    """A hashable fingerprint of *value* that ignores sensitive leaves and
    redaction placeholders, used to match list elements across a redacted
    round-trip without relying on positional order."""

    if isinstance(value, dict):
        return (
            "dict",
            tuple(
                sorted(
                    (str(k), _redaction_identity(v))
                    for k, v in value.items()
                    if not (isinstance(k, str) and is_sensitive_key(k))
                )
            ),
        )
    if isinstance(value, list):
        return ("list", tuple(_redaction_identity(v) for v in value))
    if value == REDACTED_PLACEHOLDER:
        return ("scalar", None)
    return ("scalar", value)


def mask_value(value: str) -> str:
    # Use a fixed-width mask so the rendered hint never encodes the secret's
    # length, and never reveal any prefix. Only long values expose a short
    # trailing suffix as a recognition hint.
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
    lines = [f"{key}={quote_env(value)}" for key, value in sorted(values.items()) if ENV_KEY_RE.fullmatch(key)]
    _atomic_write_text(path, "\n".join(lines) + ("\n" if lines else ""))


def _atomic_write_text(path: Path, text: str, *, mode: int = _PRIVATE_CONFIG_MODE) -> None:
    """Durably replace ``path`` without ever truncating the live config.

    The temporary file lives in the destination directory, is owner-only from
    creation, and is fully flushed and fsynced before the single atomic replace.
    No fallible operation follows ``os.replace``; consequently every exception
    raised by this function leaves the previous destination intact. Temporary
    files are removed on all pre-replace failures.
    """

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
        open_fd = -1  # ownership transferred to ``handle``
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
        except FileNotFoundError:
            pass
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
