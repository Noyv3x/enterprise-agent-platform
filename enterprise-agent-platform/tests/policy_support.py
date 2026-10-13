import json


def set_default_policy(conn, model='model-a', thinking='medium', judge=None):
    """Write the `default` model policy group: `main` is `model`/`thinking`; `judge` is `{'model':..,'thinking':..}` (default: the main model at `low`)."""
    group = {'name': 'default', 'label': '默认', 'main': {'model': model, 'thinking': thinking}, 'judge': judge or {'model': '', 'thinking': 'low'}}
    conn.execute("INSERT INTO settings(key,value,secret,updated_at) VALUES('model_policies_v2',?,0,1) "
                 "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                 (json.dumps([group]),))
