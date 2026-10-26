import getpass
import json
import os
import sys

from websockets.sync.client import connect


WS_URL = "wss://chicago-ws.londonstrategicedge.com"
SYMBOL = "NASDAQ100.F"


def main():
    api_key = os.environ.get("LSE_KEY") or getpass.getpass("LSE API key: ")
    if not api_key.strip():
        raise SystemExit("An LSE API key is required.")

    print(f"Connecting to {WS_URL} for {SYMBOL}. Press Ctrl+C to stop.", flush=True)
    try:
        with connect(WS_URL, open_timeout=10) as socket:
            socket.send(json.dumps({"action": "auth", "api_key": api_key.strip()}))

            for raw in socket:
                message = json.loads(raw)
                message_type = message.get("type")

                if message_type == "authenticated":
                    socket.send(json.dumps({"action": "subscribe", "symbol": SYMBOL}))
                    print(f"Authenticated; subscribed to {SYMBOL}.", flush=True)
                elif message_type == "subscribed":
                    print(f"Subscription confirmed: {message.get('symbol', SYMBOL)}", flush=True)
                elif message_type == "tick":
                    timestamp = message.get("ts") or message.get("timestamp")
                    price = message.get("price")
                    symbol = message.get("symbol", SYMBOL)
                    print(f"{timestamp} {symbol} price={price}", flush=True)
                elif message_type == "error":
                    raise RuntimeError(message.get("message", "Stream refused the request"))
    except KeyboardInterrupt:
        print("\nStopped.", flush=True)
    except Exception as error:
        print(f"Stream failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
