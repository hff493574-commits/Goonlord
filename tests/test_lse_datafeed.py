import threading
import unittest
from unittest.mock import patch

import lse_datafeed


class LiveTickBrokerTests(unittest.TestCase):
    def test_merging_live_ticks_preserves_historical_open_and_candle_extremes(self):
        historical = [{
            "time": 1_798_000_000,
            "open": 100,
            "high": 110,
            "low": 90,
            "close": 105,
            "volume": 50,
        }]
        live = [{
            "time": historical[0]["time"],
            "open": 107,
            "high": 112,
            "low": 95,
            "close": 111,
            "volume": 8,
        }]

        merged = lse_datafeed.LSERequestHandler.merge_bars(historical, live)

        self.assertEqual(merged, [{
            "time": historical[0]["time"],
            "open": 100,
            "high": 112,
            "low": 90,
            "close": 111,
            "volume": 50,
        }])

    def test_connects_to_chicago_live_feed(self):
        broker = lse_datafeed.LiveTickBroker("test-key")
        requested_start = "2026-10-26T02:00:00+00:00"

        with patch.object(lse_datafeed, "LSE") as lse_client, patch.object(
            lse_datafeed.threading, "Thread"
        ) as thread:
            broker.subscribe("NQ.F", requested_start)

        lse_client.assert_called_once_with(
            api_key="test-key",
            url="wss://chicago-ws.londonstrategicedge.com",
        )
        thread_args = thread.call_args.kwargs["args"]
        self.assertIs(thread_args[0], lse_client.return_value)
        self.assertCountEqual(
            thread_args[1],
            ["NASDAQ100.F", "SP500.F", "GOLD.F"],
        )
        self.assertEqual(len(thread_args), 2)
        thread.return_value.start.assert_called_once()

    def test_history_requests_native_second_bars_from_chart_api(self):
        start = int(lse_datafeed.datetime(
            2026, 10, 26, 2, 20, tzinfo=lse_datafeed.timezone.utc
        ).timestamp())
        end = start + 60
        rows = [{
            "timestamp": "2026-10-26T02:20:00+00:00",
            "open": 20000,
            "high": 20001,
            "low": 19999,
            "close": 20000.5,
            "volume": 2,
        }]
        broker = type("Broker", (), {
            "history_bars": lambda _self, _symbol, _start, _end, _interval: [],
        })()
        handler = object.__new__(lse_datafeed.LSERequestHandler)
        handler.live_broker = broker
        requested = {}
        response = {}

        def site_rpc(_name, payload):
            requested.update(payload)
            return rows

        with patch.object(handler, "site_rpc", side_effect=site_rpc), patch.object(
            handler, "send_json", side_effect=lambda body, *_: response.update(body)
        ):
            handler.history({
                "symbol": ["NQ.F"],
                "resolution": ["1S"],
                "from": [str(start)],
                "to": [str(end)],
                "countback": ["100"],
            })

        self.assertEqual(requested["sym"], "NASDAQ100.F")
        self.assertEqual(requested["width_seconds"], "1")
        self.assertEqual(requested["n"], 100)
        self.assertEqual(requested["from_ts"], "2026-10-26T02:20:00+00:00")
        self.assertEqual(requested["to_ts"], "2026-10-26T02:21:00+00:00")
        self.assertEqual(response["s"], "ok")
        self.assertEqual(response["c"], [20000.5])

    def test_history_aggregates_historical_one_second_bars_for_custom_interval(self):
        start = int(lse_datafeed.datetime(
            2026, 10, 26, 1, 0, tzinfo=lse_datafeed.timezone.utc
        ).timestamp())
        bucket = start // 10 * 10
        broker = type("Broker", (), {
            "history_bars": lambda _self, symbol, _start, _end, interval: [],
        })()
        handler = object.__new__(lse_datafeed.LSERequestHandler)
        handler.live_broker = broker
        response = {}
        requested = {}

        def site_rpc(_name, payload):
            requested.update(payload)
            return [
                {"timestamp": "2026-10-26T01:00:01+00:00", "open": 1, "high": 2, "low": 1, "close": 2, "volume": 3},
                {"timestamp": "2026-10-26T01:00:02+00:00", "open": 2, "high": 3, "low": 1, "close": 3, "volume": 4},
            ]

        with patch.object(handler, "site_rpc", side_effect=site_rpc), patch.object(
            handler, "send_json", side_effect=lambda body, *_: response.update(body)
        ):
            handler.history({
                "symbol": ["NQ.F"],
                "resolution": ["10S"],
                "from": [str(start)],
                "to": [str(start + 30)],
                "countback": ["20"],
            })

        self.assertEqual(requested["width_seconds"], "1")
        self.assertEqual(requested["n"], 200)
        self.assertEqual(response["s"], "ok")
        self.assertEqual(response["t"], [bucket])
        self.assertEqual(response["o"], [1])
        self.assertEqual(response["h"], [3])
        self.assertEqual(response["l"], [1])
        self.assertEqual(response["c"], [3])
        self.assertEqual(response["v"], [7])

    def test_maps_chart_aliases_to_provider_symbols(self):
        broker = lse_datafeed.LiveTickBroker("test-key")
        for symbol in ("NQ.F", "ES.F", "GC.F", "AAPL"):
            broker.register_symbol(symbol)

        self.assertCountEqual(
            broker.upstream_symbols(),
            ["NASDAQ100.F", "SP500.F", "GOLD.F", "AAPL"],
        )

    def test_subscribes_late_symbols_using_provider_symbol(self):
        broker = lse_datafeed.LiveTickBroker("test-key")
        subscriptions = []
        broker.client = type("Client", (), {
            "subscribe": lambda _client, symbols: subscriptions.extend(symbols),
        })()

        broker.subscribe("NQ.F", "2026-10-26T02:00:00+00:00")

        self.assertEqual(subscriptions, ["NASDAQ100.F"])

    def test_restarts_upstream_client_when_stream_iterator_ends(self):
        broker = lse_datafeed.LiveTickBroker("test-key")
        broker.stream_restart_delay_seconds = 0.01
        for symbol in ("NQ.F", "ES.F", "GC.F"):
            broker.register_symbol(symbol)
        restarted_stream = threading.Event()
        clients = []

        class StubClient:
            def __init__(self, api_key, url):
                self.api_key = api_key
                self.url = url
                clients.append(self)

            def on(self, event, callback):
                self.error_callback = callback

            def stream(self, symbols, reconnect=True, start=None):
                self.received_reconnect = reconnect
                if self is clients[0]:
                    self.received_symbols = symbols
                    self.received_start = start
                if self is clients[0]:
                    return iter(())
                restarted_stream.set()
                self.received_symbols = symbols
                self.received_start = start
                return self.wait_for_stop()

            @staticmethod
            def wait_for_stop():
                broker.stop_event.wait(timeout=1)
                return iter(())

        first_client = StubClient("test-key", lse_datafeed.LIVE_WS_URL)
        broker.client = first_client
        thread = threading.Thread(
            target=broker.run_stream,
            args=(first_client, broker.upstream_symbols()),
        )

        with patch.object(lse_datafeed, "LSE", StubClient):
            thread.start()
            try:
                self.assertTrue(restarted_stream.wait(timeout=1))
                self.assertIs(broker.client, clients[1])
                self.assertEqual(clients[1].api_key, "test-key")
                self.assertEqual(clients[1].url, lse_datafeed.LIVE_WS_URL)
                self.assertEqual(clients[1].error_callback, broker.publish_error)
                self.assertCountEqual(
                    clients[1].received_symbols,
                    ["NASDAQ100.F", "SP500.F", "GOLD.F"],
                )
                self.assertIsNone(clients[1].received_start)
                self.assertCountEqual(
                    clients[0].received_symbols,
                    ["NASDAQ100.F", "SP500.F", "GOLD.F"],
                )
                self.assertIsNone(clients[0].received_start)
                self.assertFalse(clients[0].received_reconnect)
            finally:
                broker.stop_event.set()
                thread.join(timeout=1)

        self.assertFalse(thread.is_alive())

    def test_live_stream_does_not_request_removed_upstream_replay(self):
        broker = lse_datafeed.LiveTickBroker("test-key")
        received = {}

        class StubClient:
            def stream(self, symbols, reconnect=True, start=None):
                received["symbols"] = symbols
                received["start"] = start
                received["reconnect"] = reconnect
                broker.stop_event.set()
                return iter(())

        broker.client = StubClient()
        broker.run_stream(broker.client, ["NASDAQ100.F"])

        self.assertEqual(received["symbols"], ["NASDAQ100.F"])
        self.assertIsNone(received["start"])
        self.assertFalse(received["reconnect"])


if __name__ == "__main__":
    unittest.main()
