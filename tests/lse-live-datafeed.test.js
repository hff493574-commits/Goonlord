"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const fixedNow = Date.parse("2026-10-25T13:00:00Z");
const eventSources = [];
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
		setTimeout,
		clearTimeout,
		console,
	},
);

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
