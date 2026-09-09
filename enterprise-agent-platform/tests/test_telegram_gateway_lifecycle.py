from __future__ import annotations

import threading
import unittest
from unittest import mock

from enterprise_agent_platform.service import ServiceError

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
    def test_failed_update_retries_before_confirming_later_updates(self):
        for failure in (RuntimeError("transient handler failure"), ServiceError(503, "unavailable")):
            with self.subTest(failure=type(failure).__name__):
                stop = threading.Event()
                offsets = []
                completed = []
                attempts = []
                updates = [{"update_id": 100, "message": {}}, {"update_id": 101, "message": {}}]

                class Bot:
                    def get_updates(self, *, offset=None, **_kwargs):
                        offsets.append(offset)
                        if len(offsets) == 3:
                            stop.set()
                            return []
                        return [item for item in updates if offset is None or item["update_id"] >= offset]

                gateway = TelegramGateway(_Service(), bot=Bot(), autostart=False)  # type: ignore[arg-type]
                gateway._stop = stop

                def process(update):
                    uid = update["update_id"]
                    attempts.append(uid)
                    if uid == 100 and attempts.count(100) == 1:
                        raise failure
                    completed.append(uid)

                gateway.process_update = process  # type: ignore[method-assign]
                with mock.patch.object(stop, "wait", return_value=False) as backoff:
                    gateway._poll_loop()
                self.assertEqual(offsets, [None, None, 102])
                self.assertEqual(attempts, [100, 100, 101])
                self.assertEqual(completed, [100, 101])
                self.assertTrue(backoff.called)

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
