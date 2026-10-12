"""Maps MCP results to the gateway's `{content, data, is_error}` shape. Tool output is untrusted data."""
from __future__ import annotations

import json

from .models import MAX_IMAGE_BYTES, MAX_IMAGES, MAX_TEXT_BYTES


def _clip(text):
    raw = text.encode('utf-8')
    if len(raw) <= MAX_TEXT_BYTES:
        return text
    return raw[:MAX_TEXT_BYTES].decode('utf-8', 'ignore') + f'\n[truncated: {len(raw) - MAX_TEXT_BYTES} of {len(raw)} bytes omitted]'


def _resource_text(resource):
    text = getattr(resource, 'text', None)
    if text is not None:
        return text
    return f'[binary resource {resource.uri} ({resource.mime_type or "unknown type"}) not shown]'


def _same_json(text, structured):
    """Whether structured content only repeats a text block (also the `{"result": x}` wrapper SDK servers add around primitives)."""
    try:
        value = json.loads(text)
    except ValueError:
        value = text
    if value == structured:
        return True
    return isinstance(structured, dict) and set(structured) == {'result'} and structured['result'] in (value, text)


def map_blocks(blocks):
    """`(text parts, images, omitted images)` for content blocks of a tool result, prompt message or resource."""
    parts, images, omitted = [], [], 0
    for block in blocks:
        kind = getattr(block, 'type', '')
        if kind == 'text':
            parts.append(block.text)
        elif kind == 'image':
            size = len(block.data) * 3 // 4
            if len(images) >= MAX_IMAGES or size > MAX_IMAGE_BYTES:
                omitted += 1
            else:
                images.append({'mimeType': block.mime_type, 'data': block.data})
        elif kind == 'audio':
            parts.append(f'[audio content ({block.mime_type}) not shown]')
        elif kind == 'resource':
            parts.append(_resource_text(block.resource))
        elif kind == 'resource_link':
            parts.append(f'resource link: {block.uri}')
    return parts, images, omitted


def map_tool_result(result):
    parts, images, omitted = map_blocks(result.content)
    structured = result.structured_content
    if structured is not None and not any(_same_json(part, structured) for part in parts):
        parts.append('```json\n' + json.dumps(structured, ensure_ascii=False, indent=2) + '\n```')
    if omitted:
        parts.append(f'[{omitted} image(s) omitted: at most {MAX_IMAGES} images of {MAX_IMAGE_BYTES // (1024 * 1024)} MiB per call]')
    text = _clip('\n\n'.join(parts))
    return {'content': text, 'data': {'images': images} if images else {}, 'is_error': bool(result.is_error)}


def map_resource(result):
    parts = [_resource_text(item) for item in result.contents]
    return {'content': _clip('\n\n'.join(parts)), 'data': {}, 'is_error': False}


def flatten_prompt(result):
    """Prompt messages as one text for the composer: user messages verbatim, others labelled by role."""
    lines = []
    for message in result.messages:
        parts, _, _ = map_blocks([message.content])
        text = '\n'.join(parts)
        if text:
            lines.append(text if message.role == 'user' else f'{message.role.capitalize()}: {text}')
    return _clip('\n\n'.join(lines))
