# TradingView Advanced Charts

[Demo][demo-url] | [Documentation][doc-url] | [Tutorial][tutorial-url] | [Discord community][discord-url]

This repository contains the TradingView Advanced Charts package. If you use Git in your project, please feel free to use this repository as a submodule in yours.

The `master` branch contains the most recent features and fixes.

### Local LSE Futures Demo

#### Setup and Run

Requirements: Python 3 and an LSE API key with market-data access.

```bash
python3 -m pip install -r requirements.txt
python3 lse_datafeed.py
```

The server reads `LSE_API_KEY` and `LSE_CHART_API_KEY` from the local, Git-ignored `.env` file. If `LSE_API_KEY` is missing, it asks for the key through hidden terminal input. Keep both credentials in `.env`; `LSE_API_KEY` is used for live streaming, and `LSE_CHART_API_KEY` is the provider's published chart client key used server-side for search and history. Neither is sent to the browser.

Open [http://localhost:8000](http://localhost:8000). Stop the server with `Ctrl+C`. The server uses port `8000`; if that port is occupied, change the port in `lse_datafeed.py` and use the matching URL.

In VS Code, run the **Stream BTC/USD ticks** task to print live BTC/USD ticks in a terminal; stop it with `Ctrl+C`. It uses the same `LSE_API_KEY` as the chart, so do not run the diagnostic task and chart feed at the same time if your API key allows only one upstream WebSocket connection.

#### Deploy to Render

The repository includes a `render.yaml` Blueprint. In Render, create a new Blueprint instance from this repository, set both `LSE_API_KEY` and `LSE_CHART_API_KEY` as environment variables when prompted, and deploy. Do not put credentials in `render.yaml`, source control, or frontend code. The web service is internet-accessible; anyone with its URL can use the chart and its market-data endpoints, so confirm that this is allowed by your LSE data plan before deploying.

The Blueprint uses Render's free plan, which can spin down after inactivity; that is not suitable for uninterrupted realtime streaming. Choose an always-on plan in Render if continuous service is required. The server binds to Render's `PORT` environment variable and fails clearly if the deployment is missing `LSE_API_KEY`.

#### Deploy to Vercel

The Vercel project runs the Python HTTP/SSE datafeed as a container service using [Dockerfile.vercel](Dockerfile.vercel) and [vercel.json](vercel.json). Deploy with `vercel deploy --prod --project tradingview-chart` after adding both `LSE_API_KEY` and `LSE_CHART_API_KEY` to the Vercel project's Production environment variables in the dashboard. Keep credentials out of CLI arguments, source control, and frontend code; `.vercelignore` and `.dockerignore` exclude local `.env` files. Without the configured keys, the site still serves but streaming, search, or history requests fail.

Vercel may scale container functions horizontally and suspend idle instances. The broker's single-upstream-WebSocket guarantee is per process, not shared between scaled containers, so sustained realtime behavior depends on the Vercel plan/runtime and LSE's one-connection policy. Verify the LSE license permits this public deployment and monitor the Vercel service before relying on it for live trading.

The chart starts on one-minute Nasdaq futures (`NQ.F`). Use Symbol Search to select `ES.F` for S&P 500 futures or `GC.F` for Gold futures. Search for `NQ`, `ES`, or `GC` and choose the futures result ending in `.F`.

The chart automatically saves its layout, including drawings, studies, chart colors, symbol, and interval, in this browser and restores it on your next visit. Layouts are local to the browser and are not synced between devices; clearing this site's browser storage removes the saved layout.

Use **CANVAS** to add and switch between independent workspace canvases. Each canvas appears as its own wide toolbar button with an **×** close control; buttons are numbered from Canvas 1 and renumber after removals. When the tab rail fills, scroll it horizontally to reach additional canvases and the **+** button. At least one canvas stays open. Each canvas can contain up to eight chart windows and its own economic calendar; use **CHART** to add charts to the selected canvas or open the command palette with `/` or `Ctrl+K` and run `/canvas` or `/chart`. Canvas buttons, open charts, and chart positions are saved in this browser. Click and hold a chart title bar (away from its window buttons) to move it; use the resize edges or corners to change its size, or the minimize, maximize, and close controls. Click a minimized chart's title bar or run `/charts` to restore it. Windows keep their dimensions when moved against workspace edges; resizing is always user-controlled. One chart window per canvas retains the TradingView drawing toolbar; other windows hide duplicate toolbars. **ACTIVE CHART** selects which chart receives watchlist symbol changes. Each chart saves its own symbol, interval, drawings, and studies, and all open charts receive live updates independently. **SYNC DRAWINGS** mirrors drawing creation, edits, and removals between charts showing the same symbol on the selected canvas; it is on by default and can be turned off. The multi-chart view is composed from separate Advanced Charts widgets; it does not use Trading Platform's native layout API.

The watchlist is hidden from the workspace by default. Run `/watchlist` in the command palette to open it as a movable floating window and `/watchlist hide` to dismiss it. Run `/news` or `/calendar` to open the TradingView US economic calendar in its own movable canvas window; loading it requires internet access. Switch among the minimalist **Obsidian**, **Midnight**, **Graphite**, **Forest**, and **Plum** palettes with `/theme obsidian`, `/theme midnight`, `/theme graphite`, `/theme forest`, or `/theme plum`. The selected palette is saved in this browser.

The watchlist displays futures without the `.F` suffix while retaining the provider's full symbol for chart selection. It includes Nasdaq, S&P 500, Gold, DAX, EURO STOXX 50, Euro-Bund, and Silver futures by default. Watchlist rows show the latest live trade and percentage change against the previous daily close; quotes use the same shared upstream stream as the chart.

The **TAPE** button beside the watchlist heading opens a live tick tape for the active chart symbol; changing the chart symbol switches the tape stream. Its status distinguishes an open connection from fresh ticks and marks ticks older than one minute as `STALE DATA`. Close it with its **×** button or Escape to stop that stream. The **Add Symbol** button is in the upper-right of the watchlist heading; it opens the symbol search field, which closes after selection, Escape, or clicking outside.

#### NY 18:00 Hourly & 4-Hour Range Bands

The chart adds the custom study after the initial price history loads. Its implementation is [hourly-range-bands.js](datafeeds/hourly-range-bands.js).

- It builds hourly and 4-hour candles from the chart's existing bars. Hourly periods are UTC-aligned; 4-hour periods follow New York wall-clock time (`America/New_York`): 18:00-22:00, 22:00-02:00, 02:00-06:00, 06:00-10:00, 10:00-14:00, and 14:00-18:00. The 18:00 start is explicit and the timezone automatically follows daylight-saving changes. The chart defaults to New York display time so the 18:00 boundary is shown as 18:00 even when the selected futures symbol uses a different exchange timezone. Each completed period's range is `high - low`.
- For each period size, it calculates two simple moving averages of completed ranges (lookbacks default to 5 and 20), multiplies each average by the shared `Range scale factor` (default `1`), and plots both `period open + scaled average range` and `period open - scaled average range`.
- Filled zones connect the upper levels and lower levels separately for hourly and 4-hour calculations. Line colors and zone visibility can be adjusted in the indicator's Styles settings.
- The indicator only processes bars TradingView has already loaded for the active chart. It must not call `context.new_sym`, `context.select_sym`, or `context.setMinimumAdditionalDepth`, nor make datafeed/API requests. Missing history means levels remain blank until enough complete periods are available; it must not trigger more history loading. For example, 20 one-minute candles are not enough for either default lookback.
- Hourly levels are shown on chart resolutions up to 1 hour. New York-aligned 4-hour levels are calculated only from chart bars at 1 hour or lower; the datafeed's native 4-hour candles are UTC-bucketed and cannot provide correctly aligned New York 18:00 periods, so 4-hour levels remain blank on a 4-hour chart.
- Period ranges are accumulated from the loaded chart bars, so periods partially present at the start of loaded history are excluded rather than treated as complete. Range levels update when a new period begins and use that period's open.
- The study is registered as a custom indicator in `index.html` under its NY 18:00 name and is added after initial chart data is loaded. Keep indicator initialization lightweight and return blank plot values when the library invokes it without chart bars.

The Inputs tab provides the two shared lookback lengths and scale factor. For example, if an average period range is 500 and the scale factor is `0.5`, levels are plotted 250 points above and below that period's open.

The interval menu includes `1S`, `5S`, `15S`, and `30S`. Enable custom intervals in the interval menu to enter other second or minute sizes, such as `2S`, `10S`, or `7` minutes.

#### Data Flow

- [index.html](index.html) loads the TradingView library and the custom [live datafeed](datafeeds/lse-live-datafeed.js).
- The browser requests history and symbol lookup from the local server. [lse_datafeed.py](lse_datafeed.py) uses the provider's current `site_search`, `site_symbols`, and `site_candles` endpoints and translates their responses into TradingView datafeed shapes.
- Candle history honors TradingView's `countBack`, so closed-market windows still load the latest available candles before the requested end time. Legacy chart symbols `NQ.F`, `ES.F`, and `GC.F` map to the provider's current `NASDAQ100.F`, `SP500.F`, and `GOLD.F` identifiers.
- The shared upstream stream is live-only. The broker/browser keep bounded in-memory caches of ticks received while they are running, which bridge time-frame changes and overlay locally cached ticks on recent intraday history responses. Ticks missed while the backend is stopped cannot be recovered from the live stream.
- Tick timestamps preserve sub-second precision and carry a sequence number so trades with the same timestamp are not discarded. Preserve both values; replacing them with the current time collapses multiple trades into one candle.
- Tick queues are intentionally lossless. Do not drop old queue items while delivering ticks: a busy market can produce several thousand queued ticks, and dropping them creates visible jumps.
- Second-resolution history is loaded from the provider's historical 1-second/5-second/15-second/30-second candles and merged with ticks from the in-memory live buffer. Custom second intervals aggregate the provider's 1-second history. This fills recent candles and the short gap before the live stream starts; the server tick buffer still retains the most recent 150,000 ticks per symbol for live updates.
- Arbitrary second intervals aggregate those ticks. Arbitrary minute intervals aggregate LSE 1-minute candles. Native minute resolutions continue to use the LSE candle API.
- The browser uses one SSE connection per displayed symbol; the server uses one shared LSE Chicago WebSocket (`wss://chicago-ws.londonstrategicedge.com`), subscribes using provider symbols (`NASDAQ100.F`, `SP500.F`, `GOLD.F`), and routes those feed identifiers back to chart aliases (`NQ.F`, `ES.F`, `GC.F`). Late symbol subscribers are seeded from the shared in-memory tick cache so they don't miss ticks received before they were selected. Keep this multiplexing: the API key allows only one WebSocket connection.
- The upstream tick iterator must be started without a replay `start` parameter; the provider rejects replay requests. If the iterator exits, the broker rebuilds its client after a short backoff and resumes live-only streaming.

#### Troubleshooting and Handoff Notes

- The chart resolution `1` maps to LSE `1m`; the normal adjacent historical bars are one minute apart. A time gap by itself does not imply five-minute data.
- The drawing toolbar starts with trend line, horizontal line, horizontal ray, Fibonacci retracement, rectangle, and text in its favorites. Users can add or remove drawing favorites from the chart toolbar.
- Futures have scheduled maintenance breaks. The feed does not invent flat candles during closed periods. Symbol metadata currently uses a generic `24x7` session, so configure exchange-specific sessions if the chart should visually compress closed-market time like TradingView's exchange-aware charts.
- After changing the datafeed code, reload the page so its EventSource subscription reconnects and restart `lse_datafeed.py` after Python server changes.
- A browser stream and any test client share the LSE key's single WebSocket connection. Stop the local server before testing the SDK with a separate websocket client.

Before using the library, please read the [documentation][doc-url] and the [Best Practices][best-practices-url] article.

### Issues Tracking
We use GitHub [Issues tracker][issues-url] for our project. Feel free to create bug reports and feature requests. Make sure to read the documentation before asking questions — this will avoid repeated questions, leaving us more time for developing the library.

### Stay Tuned
[Follow us][x-url] on X to receive updates.

[demo-url]: https://charting-library.tradingview.com/
[doc-url]: https://www.tradingview.com/charting-library-docs/
[tutorial-url]: https://github.com/tradingview/charting-library-tutorial
[best-practices-url]: https://www.tradingview.com/charting-library-docs/latest/getting_started/Best-Practices
[issues-url]: https://github.com/tradingview/charting_library/issues
[x-url]: https://twitter.com/intent/follow?screen_name=tv_charts
[discord-url]: https://discord.gg/UC7cGkvn4U
