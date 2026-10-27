"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const fixedNow = Date.parse("2026-10-25T13:00:00Z");
const eventSources = [];
const historyRequests = [];
let historyPayload;
class FixedDate extends Date {
	constructor(...args) {
		super(...(args.length ? args : [fixedNow]));
	}

	static now() {
		return fixedNow;
	}
}

class MockEventSource {
	constructor(url) {
		this.url = url;
		eventSources.push(this);
	}
}

const browser = {};
vm.runInNewContext(
	fs.readFileSync(path.join(__dirname, "../datafeeds/lse-live-datafeed.js"), "utf8"),
	{
		window: browser,
		Date: FixedDate,
		EventSource: MockEventSource,
		URL,
		URLSearchParams,
		setTimeout,
		clearTimeout,
		fetch: (url) => {
			historyRequests.push(new URL(url));
			return Promise.resolve({ json: () => Promise.resolve(historyPayload) });
		},
		console,
	},
);

test("history reconciliation keeps the historical open when live ticks arrived first", async () => {
	const datafeed = new browser.LSELiveDatafeed("https://example.test");
	const symbol = { ticker: "NQ.F" };
	const key = datafeed.barKey(symbol.ticker, "60");
	const barTime = Math.floor(fixedNow / 3_600_000) * 3_600_000;
	datafeed.barStates.set(key, {
		currentBar: {
			time: barTime,
			open: 20005,
			high: 20025,
			low: 19995,
			close: 20020,
			volume: 5,
		},
		lastTickTime: fixedNow,
		lastTickSequence: 1,
		symbol: symbol.ticker,
		key,
		duration: 3_600_000,
		pendingBars: [],
	});
	historyPayload = {
		s: "ok",
		t: [barTime / 1000],
		o: [20000],
		h: [20010],
		l: [19990],
		c: [20005],
		v: [100],
	};

	const result = await new Promise((resolve, reject) => {
		datafeed.getBars(
			symbol,
			"60",
			{ from: barTime / 1000 - 7200, to: fixedNow / 1000, countBack: 10 },
			(bars) => resolve(bars),
			reject,
		);
	});

	assert.equal(result.length, 1);
	assert.deepEqual(
		{ open: result[0].open, high: result[0].high, low: result[0].low, close: result[0].close },
		{ open: 20000, high: 20025, low: 19990, close: 20020 },
	);
});

test("RTH mode keeps only US equity regular-session intraday bars", async () => {
	const datafeed = new browser.LSELiveDatafeed("https://example.test");
	const client = datafeed.createClient(4);
	client.setRegularHoursEnabled(true);
	historyPayload = {
		s: "ok",
		t: [
			Date.parse("2026-10-26T13:00:00Z") / 1000,
			Date.parse("2026-10-26T13:30:00Z") / 1000,
			Date.parse("2026-10-26T20:14:00Z") / 1000,
			Date.parse("2026-10-26T20:15:00Z") / 1000,
		],
		o: [1, 2, 3, 4],
		h: [1, 2, 3, 4],
		l: [1, 2, 3, 4],
		c: [1, 2, 3, 4],
		v: [1, 1, 1, 1],
	};

	const result = await new Promise((resolve, reject) => {
		client.getBars(
			{ ticker: "NQ.F" },
			"60",
			{ from: 0, to: Date.parse("2026-10-26T20:16:00Z") / 1000, countBack: 10 },
			(bars) => resolve(bars),
			reject,
		);
	});

	assert.equal(result.length, 2);
	assert.equal(result[0].time, Date.parse("2026-10-26T13:30:00Z"));
	assert.equal(result[1].time, Date.parse("2026-10-26T20:14:00Z"));
	client.setRegularHoursEnabled(false);
	const extendedBars = await new Promise((resolve, reject) => {
		client.getBars(
			{ ticker: "NQ.F" },
			"60",
			{ from: 0, to: Date.parse("2026-10-26T20:16:00Z") / 1000, countBack: 10 },
			(bars) => resolve(bars),
			reject,
		);
	});
	assert.equal(extendedBars.length, 4);
});

test("initial ETH history loads at least three days of minute candles", async () => {
	const datafeed = new browser.LSELiveDatafeed("https://example.test");
	const client = datafeed.createClient(41);
	historyPayload = { s: "no_data" };
	const end = fixedNow / 1000;

	await new Promise((resolve, reject) => {
		client.getBars(
			{ ticker: "NQ.F" },
			"1",
			{ from: end - 1800, to: end, countBack: 300 },
			resolve,
			reject,
		);
	});

	assert.equal(historyRequests.at(-1).searchParams.get("countback"), "4320");
	assert.ok(Number(historyRequests.at(-1).searchParams.get("from")) <= end - 3 * 24 * 60 * 60);
});

test("RTH history requests enough bars to reach the previous regular session", async () => {
	const datafeed = new browser.LSELiveDatafeed("https://example.test");
	const client = datafeed.createClient(40);
	client.setRegularHoursEnabled(true);
	historyPayload = {
		s: "ok",
		t: [
			Date.parse("2026-10-26T13:30:00Z") / 1000,
			Date.parse("2026-10-27T09:30:00Z") / 1000,
			Date.parse("2026-10-27T10:30:00Z") / 1000,
			Date.parse("2026-10-27T11:00:00Z") / 1000,
		],
		o: [1, 2, 3, 4],
		h: [1, 2, 3, 4],
		l: [1, 2, 3, 4],
		c: [1, 2, 3, 4],
		v: [1, 1, 1, 1],
	};

	const beforeOpen = Date.parse("2026-10-27T11:22:00Z");
	const result = await new Promise((resolve, reject) => {
		client.getBars(
			{ ticker: "NQ.F" },
			"1",
			{ from: beforeOpen / 1000 - 3600, to: beforeOpen / 1000, countBack: 10 },
			(bars) => resolve(bars),
			reject,
		);
	});

	assert.equal(result.length, 1);
	assert.equal(result[0].time, Date.parse("2026-10-26T13:30:00Z"));
	assert.equal(historyRequests.at(-1).searchParams.get("countback"), "4320");
	assert.ok(Number(historyRequests.at(-1).searchParams.get("from")) < beforeOpen / 1000 - 3600);
});

test("older RTH history requests honor the chart's requested range when paging", async () => {
	const datafeed = new browser.LSELiveDatafeed("https://example.test");
	const client = datafeed.createClient(42);
	client.setRegularHoursEnabled(true);
	historyPayload = { s: "no_data" };
	const end = Date.parse("2026-10-15T15:00:00Z") / 1000;
	const start = end - 2 * 24 * 60 * 60;

	await new Promise((resolve, reject) => {
		client.getBars(
			{ ticker: "NQ.F" },
			"1",
			{ from: start, to: end, countBack: 300 },
			resolve,
			reject,
		);
	});

	const request = historyRequests.at(-1);
	assert.equal(Number(request.searchParams.get("from")), start);
	assert.equal(Number(request.searchParams.get("to")), end);
	assert.equal(request.searchParams.get("countback"), "2880");
});

test("RTH live candles include the 16:14 minute and align to 09:30 across DST", () => {
	const datafeed = new browser.LSELiveDatafeed("https://example.test");
	const daylightState = {
		currentBar: null,
		lastTickTime: 0,
		lastTickSequence: -1,
		symbol: "NQ.F",
		key: "NQ.F:60:RTH",
		duration: 60 * 60 * 1000,
		intraday: true,
		sessionMode: "RTH",
	};

	assert.equal(datafeed.applyTick(daylightState, daylightState.duration, {
		timestamp_ms: Date.parse("2026-10-26T13:00:00Z"),
		sequence: 1,
		price: 20000,
		volume: 1,
	}), null);
	const daylightBar = datafeed.applyTick(daylightState, daylightState.duration, {
		timestamp_ms: Date.parse("2026-10-26T13:35:00Z"),
		sequence: 2,
		price: 20001,
		volume: 1,
	});

	assert.equal(daylightBar.time, Date.parse("2026-10-26T13:30:00Z"));

	const standardState = { ...daylightState, currentBar: null, lastTickTime: 0, lastTickSequence: -1 };
	const standardBar = datafeed.applyTick(standardState, standardState.duration, {
		timestamp_ms: Date.parse("2026-01-05T14:30:00Z"),
		sequence: 1,
		price: 20002,
		volume: 1,
	});

	assert.equal(standardBar.time, Date.parse("2026-01-05T14:30:00Z"));
	const lastRthMinute = datafeed.applyTick(
		{ ...daylightState, currentBar: null, lastTickTime: 0 },
		daylightState.duration,
		{
			timestamp_ms: Date.parse("2026-10-26T20:14:00Z"),
			sequence: 1,
			price: 20003,
			volume: 1,
		},
	);
	assert.equal(lastRthMinute.time, Date.parse("2026-10-26T19:30:00Z"));
	assert.equal(datafeed.applyTick(
		{ ...daylightState, currentBar: null, lastTickTime: 0 },
		daylightState.duration,
		{
			timestamp_ms: Date.parse("2026-10-26T20:15:00Z"),
			sequence: 1,
			price: 20004,
			volume: 1,
		},
	), null);
});

test("RTH subscriptions freeze out of session and resume on the next 09:30 ET tick", () => {
	const datafeed = new browser.LSELiveDatafeed("https://example.test");
	const client = datafeed.createClient(19);
	const bars = [];
	let cacheResetCount = 0;
	client.subscribeBars(
		{ ticker: "RTH-TEST.F" },
		"60",
		(bar) => bars.push(bar),
		"rth-listener",
		() => { cacheResetCount += 1; },
	);
	client.setRegularHoursEnabled(true);
	assert.equal(cacheResetCount, 1);

	const stream = eventSources.at(-1);
	stream.onmessage({ data: JSON.stringify({
		timestamp_ms: Date.parse("2026-10-26T13:30:00Z"),
		sequence: 1,
		price: 20000,
		volume: 1,
	}) });
	assert.equal(bars.length, 1);
	const closingBar = bars[0];

	stream.onmessage({ data: JSON.stringify({
		timestamp_ms: Date.parse("2026-10-26T20:15:00Z"),
		sequence: 2,
		price: 21000,
		volume: 1,
	}) });
	assert.equal(bars.length, 1);
	assert.deepEqual(bars[0], closingBar);

	stream.onmessage({ data: JSON.stringify({
		timestamp_ms: Date.parse("2026-10-27T13:30:00Z"),
		sequence: 3,
		price: 20010,
		volume: 1,
	}) });
	assert.equal(bars.length, 2);
	assert.equal(bars[1].time, Date.parse("2026-10-27T13:30:00Z"));
	assert.equal(bars[1].open, 20010);
});

test("starts a fresh seconds subscription at the beginning of the server replay window", () => {
	const datafeed = new browser.LSELiveDatafeed("https://example.test");
	const bars = [];
	datafeed.subscribeBars({ ticker: "NQ.F" }, "1S", (bar) => bars.push(bar), "listener");

	const stream = eventSources.at(-1);
	const requestedStart = new Date(new URL(stream.url).searchParams.get("start")).getTime();
	assert.equal(requestedStart, fixedNow - 2 * 60 * 60 * 1000);

	const replayTick = {
		time: fixedNow / 1000 - 10,
		timestamp_ms: fixedNow - 10_000,
		sequence: 1,
		price: 20000,
		volume: 1,
	};
	stream.onmessage({ data: JSON.stringify(replayTick) });

	assert.equal(bars.length, 1);
	assert.equal(bars[0].time, fixedNow - 10_000);
	assert.equal(bars[0].close, replayTick.price);
});

test("replays browser-cached ticks when switching to seconds on an open stream", () => {
	const datafeed = new browser.LSELiveDatafeed("https://example.test");
	const symbol = { ticker: "NQ.F" };
	datafeed.subscribeBars(symbol, "1", () => {}, "minute-listener");

	const stream = eventSources.at(-1);
	const replayTick = {
		time: fixedNow / 1000 - 10,
		timestamp_ms: fixedNow - 10_000,
		sequence: 1,
		price: 20000,
		volume: 1,
	};
	stream.onmessage({ data: JSON.stringify(replayTick) });

	const bars = [];
	datafeed.subscribeBars(symbol, "1S", (bar) => bars.push(bar), "seconds-listener");

	assert.equal(eventSources.at(-1), stream);
	assert.equal(bars.length, 1);
	assert.equal(bars[0].time, fixedNow - 10_000);
	assert.equal(bars[0].close, replayTick.price);
});

test("keeps the latest market price from regressing on older replay ticks", () => {
	const datafeed = new browser.LSELiveDatafeed("https://example.test");
	const prices = [];
	datafeed.subscribePriceUpdates((_symbol, price) => prices.push(price));
	datafeed.subscribeBars({ ticker: "NQ.F" }, "1", () => {}, "price-listener");
	const stream = eventSources.at(-1);

	stream.onmessage({ data: JSON.stringify({
		time: fixedNow / 1000 - 5,
		timestamp_ms: fixedNow - 5_000,
		sequence: 2,
		price: 20005,
		volume: 1,
	}) });
	stream.onmessage({ data: JSON.stringify({
		time: fixedNow / 1000 - 20,
		timestamp_ms: fixedNow - 20_000,
		sequence: 1,
		price: 20000,
		volume: 1,
	}) });

	assert.equal(datafeed.getLastPrice("NQ.F"), 20005);
	assert.deepEqual(prices, [20005]);
});

test("keeps chart subscriptions independent when widgets reuse a listener GUID", () => {
	const datafeed = new browser.LSELiveDatafeed("https://example.test");
	const firstChart = datafeed.createClient(0);
	const secondChart = datafeed.createClient(1);
	const firstBars = [];
	const secondBars = [];
	const symbol = { ticker: "NQ.F" };
	const streamsBefore = eventSources.length;

	firstChart.subscribeBars(symbol, "1", (bar) => firstBars.push(bar), "shared-guid");
	secondChart.subscribeBars(symbol, "1", (bar) => secondBars.push(bar), "shared-guid");
	assert.equal(eventSources.length, streamsBefore + 1);

	const stream = eventSources.at(-1);
	stream.onmessage({ data: JSON.stringify({
		time: fixedNow / 1000,
		timestamp_ms: fixedNow,
		sequence: 1,
		price: 20000,
		volume: 1,
	}) });

	assert.equal(firstBars.length, 1);
	assert.equal(secondBars.length, 1);

	firstChart.unsubscribeBars("shared-guid");
	stream.onmessage({ data: JSON.stringify({
		time: fixedNow / 1000 + 1,
		timestamp_ms: fixedNow + 1_000,
		sequence: 2,
		price: 20001,
		volume: 1,
	}) });

	assert.equal(firstBars.length, 1);
	assert.equal(secondBars.length, 2);
});
