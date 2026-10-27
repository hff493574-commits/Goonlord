"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const chartPage = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const browser = {};
vm.runInNewContext(
	fs.readFileSync(path.join(__dirname, "../datafeeds/hourly-range-bands.js"), "utf8"),
	{ window: browser },
);

const indicator = browser.AverageHourlyRangeBands({
	Std: {
		time(context, period) {
			assert.equal(period, undefined);
			return context.bar && context.bar.time;
		},
		open(context) { return context.bar && context.bar.open; },
		high(context) { return context.bar && context.bar.high; },
		low(context) { return context.bar && context.bar.low; },
		period(context) { return context.resolution || "1"; },
	},
});

test("chart toolbar opens a default chart without passing its click event as a symbol", () => {
	assert.match(
		chartPage,
		/addChartButton\.addEventListener\('click', function \(\) \{ addChartWindow\(\); \}\)/,
	);
});

function createStudy(length2 = 20, scale = 1, resolution = "1") {
	const context = {
		new_sym() { throw new Error("Must not request other symbols"); },
		select_sym() { throw new Error("Must not switch data sources"); },
		setMinimumAdditionalDepth() { throw new Error("Must not request more chart history"); },
		resolution,
	};
	const study = new indicator.constructor();
	study.init(context);
	const values = [5, length2, scale];
	return {
		run(bar) {
			context.bar = bar;
			return study.main(context, (index) => values[index]);
		},
	};
}

test("does not require chart data during the library initialization pass", () => {
	const study = new indicator.constructor();
	study.init({});
	const result = study.main({}, () => {
		throw new Error("Inputs are unavailable without a bar");
	});
	assert.equal(result.length, 8);
	assert.ok(result.every(Number.isNaN));
});

test("plots two symmetric hourly average range bands around the current hour open", () => {
	const study = createStudy(3);
	const baseHour = 1704067200;
	let result;

	for (let hour = 0; hour <= 6; hour += 1) {
		const open = 100 + hour * 100;
		const range = hour;
		result = study.run({
			time: baseHour + hour * 3600,
			open,
			high: open + range,
			low: open,
		});
	}

	assert.equal(result[0], 703);
	assert.equal(result[1], 697);
	assert.equal(result[2], 704);
	assert.equal(result[3], 696);
});

test("multiplies each average range by the scale factor before plotting", () => {
	const study = createStudy(3, 0.5);
	const baseHour = 1704067200;
	let result;

	for (let hour = 0; hour <= 6; hour += 1) {
		const open = 100 + hour * 100;
		result = study.run({
			time: baseHour + hour * 3600,
			open,
			high: open + hour,
			low: open,
		});
	}

	assert.equal(result[0], 701.5);
	assert.equal(result[1], 698.5);
	assert.equal(result[2], 702);
	assert.equal(result[3], 698);
});

test("keeps bands blank with only 20 one-minute bars", () => {
	const study = createStudy();
	const start = 1704067200;
	let result;

	for (let minute = 0; minute < 20; minute += 1) {
		result = study.run({
			time: start + minute * 60,
			open: 100,
			high: 101,
			low: 99,
		});
	}

	assert.ok(result.every(Number.isNaN));
});

test("registers line styles separately from their defaults and fills both zones", () => {
	assert.deepEqual(
		Object.keys(indicator.metainfo.styles),
		["hour_upper5", "hour_lower5", "hour_upper20", "hour_lower20",
			"fourHour_upper5", "fourHour_lower5", "fourHour_upper20", "fourHour_lower20"],
	);
	assert.equal(indicator.metainfo.filledAreas.length, 4);
	assert.ok(indicator.metainfo.filledAreas.every((area) => area.type === "plot_plot"));
	assert.equal(indicator.metainfo.defaults.inputs.length1, 5);
	assert.equal(indicator.metainfo.defaults.inputs.length2, 20);
	assert.equal(indicator.metainfo.defaults.inputs.scale, 1);
});

test("aggregates 4-hour ranges from loaded hourly bars and anchors them to the current 4-hour open", () => {
	const study = createStudy(3, 1, "60");
	const base = Date.parse("2024-01-02T23:00:00Z") / 1000;
	let result;

	for (let bucket = 0; bucket <= 7; bucket += 1) {
		for (let part = 0; part < 4; part += 1) {
			const open = 1000 + bucket * 100;
			const range = bucket + 1;
			result = study.run({
				time: base + (bucket * 4 + part) * 3600,
				open,
				high: open + range,
				low: open,
			});
		}
	}

	assert.equal(result[4], 1705);
	assert.equal(result[5], 1695);
	assert.equal(result[6], 1706);
	assert.equal(result[7], 1694);
});

test("keeps NY-aligned 4-hour bands blank on a UTC-bucketed 4-hour chart", () => {
	const study = createStudy(1, 1, "240");
	const base = Date.parse("2024-01-02T23:00:00Z") / 1000;
	study.run({ time: base, open: 100, high: 102, low: 98 });
	study.run({ time: base + 4 * 3600, open: 200, high: 203, low: 197 });
	const result = study.run({ time: base + 8 * 3600, open: 300, high: 305, low: 295 });

	assert.ok(result.slice(0, 4).every(Number.isNaN));
	assert.ok(result.slice(4).every(Number.isNaN));
});

test("starts 4-hour ranges at 6pm, 10pm, 2am, 6am, 10am, and 2pm New York time", () => {
	const study = createStudy(1, 1, "60");
	const bars = [
		["2024-01-01T23:00:00Z", 100, 102],
		["2024-01-02T03:00:00Z", 200, 208],
		["2024-01-02T07:00:00Z", 300, 312],
		["2024-01-02T11:00:00Z", 400, 416],
		["2024-01-02T15:00:00Z", 500, 520],
		["2024-01-02T19:00:00Z", 600, 624],
		["2024-01-02T23:00:00Z", 700, 728],
		["2024-01-03T03:00:00Z", 800, 832],
	];
	let result;
	const observed = [];

	bars.forEach(([time, open, high]) => {
		result = study.run({
			time: Date.parse(time) / 1000,
			open,
			high,
			low: open,
		});
		observed.push(Array.from(result.slice(6)));
	});

	assert.deepEqual(observed.slice(2), [
		[308, 292],
		[412, 388],
		[516, 484],
		[620, 580],
		[724, 676],
		[828, 772],
	]);
});

test("uses exactly 18:00 New York as a new 4-hour period boundary", () => {
	const study = createStudy(1, 1, "60");
	const bars = [
		["2024-01-02T22:00:00Z", 100, 150],
		["2024-01-02T23:00:00Z", 100, 101],
		["2024-01-03T02:00:00Z", 100, 102],
		["2024-01-03T03:00:00Z", 100, 101],
	];
	let result;

	bars.forEach(([time, open, high]) => {
		result = study.run({
			time: Date.parse(time) / 1000,
			open,
			high,
			low: open,
		});
	});

	assert.equal(result[6], 102);
	assert.equal(result[7], 98);
});

test("defaults chart time labels to New York to show the 18:00 NY boundary", () => {
	assert.match(chartPage, /timezone:\s*'America\/New_York'/);
});

test("keeps the New York 6pm anchor across daylight-saving time", () => {
	const study = createStudy(1, 1, "60");
	const bars = [
		["2024-07-01T22:00:00Z", 100, 102],
		["2024-07-02T02:00:00Z", 200, 208],
		["2024-07-02T06:00:00Z", 300, 312],
	];
	let result;

	bars.forEach(([time, open, high]) => {
		result = study.run({
			time: Date.parse(time) / 1000,
			open,
			high,
			low: open,
		});
	});

	assert.equal(result[6], 308);
	assert.equal(result[7], 292);
});
