/** Conservative credential-shape redaction for model-bound or diagnostic text. */
export function redactSensitiveText(input: string): string {
  let value = String(input);
  value = value.replace(
    /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    "[redacted-private-key]",
  );
  value = value.replace(
    /((?:Proxy-)?Authorization\s*:\s*)(?:[A-Za-z][\w.+-]*\s+)?[^\s"']+/gi,
    "$1[redacted]",
  );
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]");
  value = value.replace(
    /((?:x-api-key|x-goog-api-key|api-key|apikey|x-api-token|x-auth-token|x-access-token)\s*:\s*)[^\s,"']+/gi,
    "$1[redacted]",
  );
  value = value.replace(
    /\b(?:sk-[A-Za-z0-9_-]{10,}|sk_[A-Za-z0-9_]{10,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|xapp-\d+-[A-Za-z0-9-]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|pplx-[A-Za-z0-9]{10,}|fal_[A-Za-z0-9_-]{10,}|fc-[A-Za-z0-9]{10,}|bb_live_[A-Za-z0-9_-]{10,}|gAAAA[A-Za-z0-9_=-]{20,}|AKIA[A-Z0-9]{16}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|SG\.[A-Za-z0-9_-]{10,}|hf_[A-Za-z0-9]{10,}|r8_[A-Za-z0-9]{10,}|npm_[A-Za-z0-9]{10,}|pypi-[A-Za-z0-9_-]{10,}|dop_v1_[A-Za-z0-9]{10,}|doo_v1_[A-Za-z0-9]{10,}|am_[A-Za-z0-9_-]{10,}|tvly-[A-Za-z0-9]{10,}|exa_[A-Za-z0-9]{10,}|gsk_[A-Za-z0-9]{10,}|xai-[A-Za-z0-9]{30,}|ntn_[A-Za-z0-9]{10,}|fw[-_][A-Za-z0-9]{30,}|fpk_[A-Za-z0-9]{30,})\b/g,
    "[redacted-token]",
  );
  value = value.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g,
    "[redacted-jwt]",
  );
  value = value.replace(/\b(?:bot)?\d{8,}:[-A-Za-z0-9_]{30,}\b/g, "[redacted-token]");
  value = value.replace(
    /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/@]+:)([^@\s]+)(@)/gi,
    "$1[redacted]$3",
  );
  value = value.replace(
    /((?:https?|wss?|git|ssh|ftp|ftps|sftp):\/\/)([^\s:@/]{8,})(@[^\s]+)/gi,
    "$1[redacted]$3",
  );
  value = value.replace(
    /([?&](?:access_token|refresh_token|id_token|token|api_key|apikey|client_secret|password|auth|jwt|session|secret|key|code|signature|x-amz-signature)=)[^&#\s]*/gi,
    "$1[redacted]",
  );
  value = value.replace(
    /("(?:api_?key|token|secret|password|access_token|refresh_token|auth_token|bearer|secret_value|raw_secret|secret_input|key_material)"\s*:\s*")[^"]*(")/gi,
    "$1[redacted]$2",
  );
  value = value.replace(
    /\b(token|password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization)\b(\s*[:=]\s*)([^\s,;]{4,})/gi,
    (_match, label: string, separator: string) => `${label}${separator}[redacted]`,
  );
  value = value.replace(
    /(^[ \t]*[A-Za-z0-9_.-]*(?:api[_. -]?key|token|secret|passwd|password|credential)[A-Za-z0-9_.-]*)(:[ \t]*)(?!["'])[^\s&]+/gim,
    "$1$2[redacted]",
  );
  return value;
}
