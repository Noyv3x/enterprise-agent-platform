from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SENSITIVE_RE = re.compile(r"(API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|JWT)", re.IGNORECASE)
ENV_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,100}$")


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
            "value": "" if secret and configured else value_for_json(value),
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
    ConfigField("terminal.backend", "终端后端", "终端", "select", options=("local", "docker", "singularity", "modal", "ssh")),
    ConfigField("terminal.cwd", "终端工作目录", "终端"),
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
    ConfigField("TERMINAL_ENV", "终端环境后端覆盖", "终端"),
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


def read_hermes_internal_config(config_path: Path, env_path: Path) -> dict[str, Any]:
    mapping, yaml_text, error = read_yaml_mapping_with_text(config_path)
    env_values = read_env_file(env_path)
    return {
        "config_path": str(config_path),
        "env_path": str(env_path),
        "yaml_text": yaml_text,
        "yaml_error": error,
        "sections": summarize_mapping(mapping),
        "fields": fields_from_mapping(HERMES_YAML_FIELDS, mapping),
        "env": fields_from_env(HERMES_ENV_FIELDS, env_values),
    }


def read_cognee_internal_config(env_path: Path, effective_env: dict[str, str] | None = None) -> dict[str, Any]:
    env_values = dict(effective_env or {})
    env_values.update(read_env_file(env_path))
    return {
        "env_path": str(env_path),
        "env": fields_from_env(COGNEE_ENV_FIELDS, env_values),
    }


def update_yaml_text(config_path: Path, yaml_text: str) -> None:
    validate_yaml_mapping(yaml_text)
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(yaml_text.rstrip() + "\n", encoding="utf-8")


def update_yaml_values(config_path: Path, updates: dict[str, Any]) -> None:
    mapping, _text, error = read_yaml_mapping_with_text(config_path)
    if error:
        raise ValueError(f"fix YAML before editing fields: {error}")
    fields = {field.key: field for field in HERMES_YAML_FIELDS}
    for key, value in updates.items():
        field = fields.get(str(key))
        if not field:
            raise ValueError(f"unsupported config key: {key}")
        set_nested(mapping, field.key, coerce_field_value(field, value))
    try:
        import yaml
    except Exception as exc:
        raise ValueError("PyYAML is required to edit YAML config") from exc
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(yaml.safe_dump(mapping, sort_keys=False, allow_unicode=True), encoding="utf-8")


def update_env_file(env_path: Path, updates: dict[str, Any]) -> None:
    values = read_env_file(env_path)
    for key, value in updates.items():
        clean = str(key).strip().upper()
        if not ENV_KEY_RE.fullmatch(clean):
            raise ValueError(f"invalid env key: {key}")
        if value is None:
            values.pop(clean, None)
        else:
            values[clean] = str(value)
    write_env_file(env_path, values)


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


def fields_from_mapping(fields: tuple[ConfigField, ...], mapping: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    for field in fields:
        found, value = get_nested(mapping, field.key)
        result.append(field.to_dict(value if found else "", configured=found and is_configured_value(value)))
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


def is_sensitive_key(key: str) -> bool:
    return bool(SENSITIVE_RE.search(key))


def mask_value(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:3]}...{value[-4:]}"


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
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"{key}={quote_env(value)}" for key, value in sorted(values.items()) if ENV_KEY_RE.fullmatch(key)]
    path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def quote_env(value: str) -> str:
    safe = str(value).replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')
    return f'"{safe}"'


def unquote_env(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] == '"':
        return value[1:-1].replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1]
    return value
