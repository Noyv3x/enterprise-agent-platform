from __future__ import annotations

import threading
import unittest

from enterprise_agent_platform.telegram_gateway import TelegramGateway


class _Service:
    def telegram_bot_token(self):
        return "test-token"

    def telegram_polling_enabled(self):
        return True


class _BlockingBot:
    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()

    def get_updates(self, **_kwargs):
        self.entered.set()
        self.release.wait(2)
        return [{"update_id": 1, "message": {}}]


class TelegramGatewayLifecycleTests(unittest.TestCase):
    def test_stopped_poller_does_not_process_batch_returned_after_stop(self):
        bot = _BlockingBot()
        gateway = TelegramGateway(_Service(), bot=bot, autostart=True)  # type: ignore[arg-type]
        processed: list[dict] = []
        gateway.process_update = processed.append  # type: ignore[method-assign]

        gateway.start()
        self.assertTrue(bot.entered.wait(1))
        gateway._stop.set()
        bot.release.set()
        gateway._thread.join(1)  # type: ignore[union-attr]

        self.assertEqual(processed, [])
        self.assertFalse(gateway._thread.is_alive())  # type: ignore[union-attr]


if __name__ == "__main__":
    unittest.main()
