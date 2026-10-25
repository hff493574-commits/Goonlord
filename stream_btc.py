import os
import sys

from lse import LSE

from lse_datafeed import load_local_env


def main():
    load_local_env()
    api_key = os.environ.get("LSE_API_KEY")
    if not api_key:
        raise SystemExit("LSE_API_KEY is missing. Add it to the ignored .env file.")

    client = LSE(api_key=api_key)
    client.on("connected", lambda: print("Connected to live feed.", flush=True))
    client.on("authenticated", lambda: print("Authenticated; subscribing to BTC/USD.", flush=True))
    client.on("error", lambda error: print(f"Feed error: {error}", file=sys.stderr, flush=True))

    print("Streaming BTC/USD. Press Ctrl+C to stop.", flush=True)
    try:
        for tick in client.stream(["BTC/USD"]):
            replay_label = " REPLAY" if tick.replay else ""
            print(
                f"{tick.datetime or tick.timestamp} BTC/USD "
                f"price={tick.price} volume={tick.volume or 0}{replay_label}",
                flush=True,
            )
    except KeyboardInterrupt:
        print("\nStopped BTC/USD stream.", flush=True)
        client.disconnect()


if __name__ == "__main__":
    main()
