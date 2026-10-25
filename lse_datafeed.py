import getpass
import json
import os
import queue
import re
import threading
from collections import deque
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen

from lse import LSE


SITE_API_ROOT = "https://api.londonstrategicedge.com"
CHART_SYMBOL_ALIASES = {
    "NQ.F": "NASDAQ100.F",
    "ES.F": "SP500.F",
    "GC.F": "GOLD.F",
}
RESOLUTIONS = {
    "1S": "1s",
    "5S": "5s",
    "15S": "15s",
    "30S": "30s",
    "1": "1m",
    "3": "3m",
    "5": "5m",
    "15": "15m",
    "30": "30m",
    "60": "1h",
    "240": "4h",
    "1D": "1d",
    "1W": "1w",
    "1M": "1mo",
}
CHART_RESOLUTIONS = list(RESOLUTIONS)
LIVE_REPLAY_HOURS = 2
SUPPORTED_DATASETS = {
    "stocks",
    "fx",
    "crypto",
    "etf",
    "commodity",
    "index",
    "futures",
}


def load_local_env():
    env_path = Path(__file__).with_name(".env")
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        name, separator, value = line.partition("=")
        name = name.strip()
        if separator and name and not name.startswith("#") and name not in os.environ:
            os.environ[name] = value.strip().strip("\"'")


class LSERequestHandler(SimpleHTTPRequestHandler):
    api_key = ""
    catalog = None
    live_broker = None

    def do_GET(self):
        parsed = urlsplit(self.path)
        params = parse_qs(parsed.query)

        if parsed.path in {"/search", "/symbols", "/history", "/stream"} and not self.api_key:
            self.send_json({"s": "error", "errmsg": "LSE_API_KEY is not configured for this deployment"}, 503)
            return

        try:
            if parsed.path == "/config":
                self.send_json({
                    "supports_search": True,
                    "supports_group_request": False,
                    "supports_marks": False,
                    "supports_timescale_marks": False,
                    "supports_time": True,
                    "supported_resolutions": CHART_RESOLUTIONS,
                })
            elif parsed.path == "/search":
                self.search(params)
            elif parsed.path == "/symbols":
                self.symbol_info(params)
            elif parsed.path == "/history":
                self.history(params)
            elif parsed.path == "/stream":
                self.stream(params)
            elif parsed.path == "/time":
                self.send_text(str(int(datetime.now(timezone.utc).timestamp())))
            else:
                super().do_GET()
        except (HTTPError, URLError, TimeoutError, ValueError, KeyError) as error:
            self.send_json({"s": "error", "errmsg": self.safe_error(error)}, 502)

    def search(self, params):
        query = params.get("query", [""])[0].strip().casefold()
        if not query:
            self.send_json([])
            return
        search_aliases = {
            "nq": "NASDAQ100",
            "nq.f": "NASDAQ100.F",
            "es": "SP500",
            "es.f": "SP500.F",
            "gc": "GOLD.F",
            "gc.f": "GOLD.F",
            "gold": "GOLD.F",
        }
        rows = self.site_rpc("site_search", {
            "q": search_aliases.get(query, query),
            "lim": 30,
        })
        self.send_json([
            {
                "symbol": row.get("symbol", ""),
                "full_name": row.get("symbol", ""),
                "description": row.get("display_name") or row.get("symbol", ""),
                "exchange": row.get("market") or "",
                "ticker": row.get("symbol", ""),
                "type": row.get("category", ""),
            }
            for row in rows
            if row.get("category") in SUPPORTED_DATASETS | {"stock"}
        ])

    def symbol_info(self, params):
        symbol = params.get("symbol", [""])[0].strip()
        row = self.get_symbol_record(symbol)
        if row is None:
            self.send_json({"s": "error", "errmsg": f"Unknown LSE symbol: {symbol}"}, 404)
            return

        is_us_futures = row.get("category") == "futures" and self.provider_symbol(symbol) in {
            "NASDAQ100.F", "SP500.F", "GOLD.F",
        }
        decimals = int(row.get("decimals") or 2)
        self.send_json({
            "name": symbol,
            "ticker": symbol,
            "description": row.get("display_name") or row["symbol"],
            "type": row.get("category", ""),
            "session": "1700-1600:23456" if is_us_futures else "24x7",
            "timezone": "America/Chicago" if is_us_futures else "Etc/UTC",
            "exchange": row.get("exchange") or row.get("market") or "LSE",
            "listed_exchange": row.get("market") or "LSE",
            "minmov": 1,
            "pricescale": 10 ** decimals,
            "has_intraday": True,
            "supported_resolutions": CHART_RESOLUTIONS,
            "has_seconds": True,
            "seconds_multipliers": ["1"],
            "intraday_multipliers": ["1", "3", "5", "15", "30", "60", "240"],
            "has_daily": True,
            "has_weekly_and_monthly": True,
            "volume_precision": 2,
            "data_status": "streaming",
        })

    def history(self, params):
        symbol = self.first(params, "symbol")
        resolution = self.first(params, "resolution")
        if not symbol:
            raise ValueError("A valid symbol and resolution are required")
        timeframe, base_seconds, aggregate_seconds = self.resolution_details(resolution)

        from_epoch = int(self.first(params, "from"))
        to_epoch = int(self.first(params, "to"))
        try:
            requested_limit = min(max(int(self.first(params, "countback", "1000")), 1), 5000)
        except ValueError:
            requested_limit = 1000
        aggregation_factor = max(1, aggregate_seconds // base_seconds) if aggregate_seconds else 1
        next_day = datetime.fromtimestamp(to_epoch, timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        ) + timedelta(days=1)
        bars_after_to = max(0, int((next_day.timestamp() - to_epoch) // base_seconds))
        limit = min(requested_limit * aggregation_factor + bars_after_to + 2, 5000)

        if resolution.endswith("S"):
            bars = self.live_broker.history_bars(
                symbol,
                int(self.first(params, "from")),
                int(self.first(params, "to")),
                int(resolution[:-1]),
            )[-requested_limit:]
            if not bars:
                self.send_json({"s": "no_data"})
                return
            result = {"s": "ok", "t": [], "o": [], "h": [], "l": [], "c": [], "v": []}
            for bar in bars:
                result["t"].append(bar["time"])
                result["o"].append(bar["open"])
                result["h"].append(bar["high"])
                result["l"].append(bar["low"])
                result["c"].append(bar["close"])
                result["v"].append(bar["volume"])
            self.send_json(result)
            return

        rows = self.site_rpc("site_candles", {
            "sym": self.provider_symbol(symbol),
            "width_seconds": str(base_seconds),
            "n": limit,
            "before": datetime.fromtimestamp(to_epoch, timezone.utc).isoformat(),
            "from_ts": None,
            "to_ts": None,
        })

        bars = sorted((self.row_to_bar(row) for row in rows), key=lambda bar: bar["time"])
        bars = [bar for bar in bars if bar["time"] <= to_epoch]
        if not bars:
            self.send_json({"s": "no_data"})
            return

        if aggregate_seconds:
            bars = self.aggregate_bars(bars, aggregate_seconds)
        if re.fullmatch(r"\d+", resolution):
            live_interval = aggregate_seconds or base_seconds
            live_bars = self.live_broker.history_bars(
                symbol,
                from_epoch,
                to_epoch,
                live_interval,
            )
            bars = self.merge_bars(bars, live_bars)
        bars = bars[-requested_limit:]

        result = {"s": "ok", "t": [], "o": [], "h": [], "l": [], "c": [], "v": []}
        for bar in bars:
            result["t"].append(bar["time"])
            result["o"].append(bar["open"])
            result["h"].append(bar["high"])
            result["l"].append(bar["low"])
            result["c"].append(bar["close"])
            result["v"].append(bar["volume"])
        self.send_json(result)

    @staticmethod
    def resolution_details(resolution):
        seconds_match = re.fullmatch(r"(\d+)S", resolution)
        if seconds_match:
            seconds = int(seconds_match.group(1))
            if seconds < 1:
                raise ValueError("Seconds resolutions must be positive")
            return "1s", 1, seconds
        if resolution == "240":
            return "1h", 3600, 14400
        timeframe = RESOLUTIONS.get(resolution)
        if timeframe:
            if timeframe.endswith("mo"):
                base_seconds = 30 * 86400
            elif timeframe.endswith("w"):
                base_seconds = 7 * 86400
            elif timeframe.endswith("d"):
                base_seconds = 86400
            elif timeframe.endswith("h"):
                base_seconds = int(timeframe[:-1]) * 3600
            else:
                base_seconds = int(timeframe[:-1]) * 60
            return timeframe, base_seconds, None
        minutes_match = re.fullmatch(r"\d+", resolution)
        if minutes_match:
            minutes = int(resolution)
            if minutes < 1:
                raise ValueError("Minute resolutions must be positive")
            if minutes in {3, 5, 15, 30, 60, 240}:
                return RESOLUTIONS[resolution], minutes * 60, None
            return "1m", 60, minutes * 60
        raise ValueError(f"Unsupported resolution: {resolution}")

    @staticmethod
    def row_to_bar(row):
        stamp = row.get("timestamp", row.get("ts"))
        if isinstance(stamp, (int, float)):
            seconds = int(stamp / 1000) if stamp > 10_000_000_000 else int(stamp)
        else:
            parsed = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            seconds = int(parsed.timestamp())
        return {
            "time": seconds,
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
            "volume": float(row.get("volume") or 0),
        }

    @staticmethod
    def aggregate_bars(bars, interval_seconds):
        aggregated = []
        for bar in bars:
            bucket_time = bar["time"] // interval_seconds * interval_seconds
            if not aggregated or aggregated[-1]["time"] != bucket_time:
                aggregated.append({**bar, "time": bucket_time})
                continue
            current = aggregated[-1]
            current["high"] = max(current["high"], bar["high"])
            current["low"] = min(current["low"], bar["low"])
            current["close"] = bar["close"]
            current["volume"] += bar["volume"]
        return aggregated

    @staticmethod
    def merge_bars(historical_bars, live_bars):
        bars_by_time = {bar["time"]: bar for bar in historical_bars}
        bars_by_time.update({bar["time"]: bar for bar in live_bars})
        return [bars_by_time[bar_time] for bar_time in sorted(bars_by_time)]

    def stream(self, params):
        symbol = self.first(params, "symbol").strip()
        if self.get_symbol_record(symbol) is None:
            self.send_json({"error": f"Unknown LSE symbol: {symbol}"}, 404)
            return

        start = self.first(params, "start")
        if not start:
            start = (datetime.now(timezone.utc) - timedelta(minutes=60)).isoformat()
        subscriber = self.live_broker.subscribe(symbol, start)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        self.wfile.write(b"retry: 3000\n\n")
        self.wfile.flush()

        try:
            while True:
                try:
                    message = subscriber.get(timeout=15)
                    body = json.dumps(message, separators=(",", ":"))
                    self.wfile.write(f"data: {body}\n\n".encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            self.live_broker.unsubscribe(symbol, subscriber)

    @staticmethod
    def provider_symbol(symbol):
        return CHART_SYMBOL_ALIASES.get(symbol.upper(), symbol)

    def get_symbol_record(self, symbol):
        provider_symbol = self.provider_symbol(symbol)
        if self.catalog is None:
            self.catalog = {}
        if provider_symbol not in self.catalog:
            params = urlencode({
                "symbol": f"eq.{provider_symbol}",
                "is_active": "eq.true",
                "select": "symbol,display_name,category,market,decimals,tick_size,currency,exchange,country",
                "limit": 1,
            })
            rows = self.site_api_request(f"site_symbols?{params}")
            self.catalog[provider_symbol] = rows[0] if rows else None
        return self.catalog[provider_symbol]

    def site_rpc(self, name, payload):
        return self.site_api_request(f"rpc/{name}", payload=payload)

    @staticmethod
    def site_api_request(path, payload=None):
        api_key = os.environ.get("LSE_CHART_API_KEY")
        if not api_key:
            raise ValueError("LSE_CHART_API_KEY is not configured")
        request = Request(
            f"{SITE_API_ROOT}/{path.lstrip('/')}",
            data=json.dumps(payload).encode("utf-8") if payload is not None else None,
            headers={
                "x-api-key": api_key,
                "Content-Type": "application/json",
                "User-Agent": "LSE-TradingView-local-datafeed/1.0",
            },
        )
        with urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_text(self, value):
        body = value.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    @staticmethod
    def first(params, key, default=""):
        return params.get(key, [default])[0]

    @staticmethod
    def safe_error(error):
        if isinstance(error, HTTPError):
            try:
                detail = error.read().decode("utf-8", "replace")[:300]
            except OSError:
                detail = ""
            return f"LSE API returned HTTP {error.code}: {detail or error.reason}"
        if isinstance(error, URLError):
            return f"Could not reach the LSE API: {error.reason}"
        return str(error)


class LiveTickBroker:
    def __init__(self, api_key):
        self.api_key = api_key
        self.lock = threading.Lock()
        self.subscribers = {}
        self.requested_symbols = set()
        self.feed_symbol_map = {}
        self.client = None
        self.thread = None
        self.tick_history = {}
        self.tick_sequence = 0
        self.default_symbols = {
            "NQ.F": ("NQ.F", "NASDAQ100.F"),
            "ES.F": ("ES.F", "SP500.F"),
            "GC.F": ("GC.F", "GOLD.F"),
        }

    def subscribe(self, symbol, start):
        subscriber = queue.Queue()
        start_time = self.parse_start_time(start)
        with self.lock:
            for tick in self.tick_history.get(symbol, ()):
                if tick["time"] >= start_time:
                    subscriber.put_nowait(tick)
            self.subscribers.setdefault(symbol, set()).add(subscriber)
            if self.client is None:
                self.client = LSE(api_key=self.api_key)
                self.client.on("error", self.publish_error)
                initial_symbols = list(dict.fromkeys([*self.default_symbols, symbol]))
                for requested_symbol in initial_symbols:
                    self.register_symbol(requested_symbol)
                replay_start = min(
                    start_time,
                    int((datetime.now(timezone.utc) - timedelta(hours=LIVE_REPLAY_HOURS)).timestamp()),
                )
                self.thread = threading.Thread(
                    target=self.run_stream,
                    args=(
                        self.client,
                        initial_symbols,
                        datetime.fromtimestamp(replay_start, timezone.utc).isoformat(),
                    ),
                    daemon=True,
                )
                self.thread.start()
            elif symbol not in self.requested_symbols:
                self.register_symbol(symbol)
                self.client.subscribe([symbol])
        return subscriber

    def unsubscribe(self, symbol, subscriber):
        with self.lock:
            self.subscribers.get(symbol, set()).discard(subscriber)

    def run_stream(self, client, symbols, start):
        try:
            for tick in client.stream(symbols, start=start):
                self.publish(tick)
        except Exception as error:
            self.publish_error(error)

    def register_symbol(self, symbol):
        self.requested_symbols.add(symbol)
        aliases = self.default_symbols.get(symbol, (symbol,))
        for alias in aliases:
            self.feed_symbol_map[alias.casefold()] = symbol

    @staticmethod
    def parse_start_time(value):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return int(parsed.timestamp())
        except (AttributeError, TypeError, ValueError):
            return int(datetime.now(timezone.utc).timestamp()) - 3600

    def publish(self, tick):
        timestamp = tick.datetime
        if timestamp is None and tick.timestamp is not None:
            try:
                epoch = float(tick.timestamp)
                if epoch > 10_000_000_000:
                    epoch /= 1000
                timestamp = datetime.fromtimestamp(epoch, timezone.utc)
            except (TypeError, ValueError, OverflowError):
                timestamp = None
        if timestamp is None:
            timestamp = datetime.now(timezone.utc)
        message = {
            "symbol": tick.symbol,
            "time": int(timestamp.timestamp()),
            "timestamp_ms": timestamp.timestamp() * 1000,
            "price": float(tick.price),
            "volume": float(tick.volume or 0),
        }
        with self.lock:
            self.tick_sequence += 1
            message["sequence"] = self.tick_sequence
            symbol = self.feed_symbol_map.get(tick.symbol.casefold(), tick.symbol)
            history = self.tick_history.setdefault(symbol, deque(maxlen=150_000))
            history.append(message)
            subscribers = list(self.subscribers.get(symbol, ()))
        self.deliver(subscribers, message)

    def history_bars(self, symbol, start, end, interval_seconds):
        with self.lock:
            ticks = list(self.tick_history.get(symbol, ()))
        ticks.sort(key=lambda tick: (tick.get("timestamp_ms", tick["time"] * 1000), tick.get("sequence", 0)))
        bars = []
        for tick in ticks:
            tick_time = tick.get("timestamp_ms", tick["time"] * 1000) / 1000
            if tick_time < start or tick_time > end:
                continue
            bucket_time = int(tick_time) // interval_seconds * interval_seconds
            if not bars or bars[-1]["time"] != bucket_time:
                bars.append({
                    "time": bucket_time,
                    "open": tick["price"],
                    "high": tick["price"],
                    "low": tick["price"],
                    "close": tick["price"],
                    "volume": tick["volume"],
                })
                continue
            bar = bars[-1]
            bar["high"] = max(bar["high"], tick["price"])
            bar["low"] = min(bar["low"], tick["price"])
            bar["close"] = tick["price"]
            bar["volume"] += tick["volume"]
        return bars

    def publish_error(self, error):
        message = {"error": str(error)}
        with self.lock:
            subscribers = [subscriber for group in self.subscribers.values() for subscriber in group]
        self.deliver(subscribers, message)

    @staticmethod
    def deliver(subscribers, message):
        for subscriber in subscribers:
            try:
                subscriber.put_nowait(message)
            except queue.Full:
                pass


if __name__ == "__main__":
    load_local_env()
    key = os.environ.get("LSE_API_KEY")
    if not key:
        if os.environ.get("PORT"):
            print("LSE_API_KEY is not configured; chart data endpoints will return HTTP 503")
        else:
            key = getpass.getpass("LSE_API_KEY (input hidden): ")
            if not key.strip():
                raise SystemExit("An LSE API key is required")
    if key:
        LSERequestHandler.api_key = key.strip()
        LSERequestHandler.live_broker = LiveTickBroker(key.strip())
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), LSERequestHandler)
    print(f"LSE chart demo listening on port {port}")
    server.serve_forever()