import json

from enterprise_agent_platform.db import MODEL_SLOTS


def set_default_policy(conn, model='model-a', thinking='medium', **slots):
    """Write the `default` model policy group: every slot is `model`/`thinking` unless overridden as `slot={'model':..,'thinking':..}`."""
    group = {slot: slots.get(slot, {'model': model, 'thinking': thinking}) for slot in MODEL_SLOTS}
    conn.execute("INSERT INTO settings(key,value,secret,updated_at) VALUES('model_policies_v1',?,0,1) "
                 "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                 (json.dumps([{'name': 'default', 'label': '默认', 'slots': group}]),))
