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

const indicator = browser.RTHRangeBands({
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

test("ETH mode keeps premarket and after-hours bars in its normal periods", () => {
	const study = createStudy(1, 1, "60");
	study.run({
		time: Date.parse("2024-01-02T21:00:00Z") / 1000,
		open: 100,
		high: 1000,
		low: 100,
	});
	study.run({
		time: Date.parse("2024-01-02T22:00:00Z") / 1000,
		open: 200,
		high: 210,
		low: 200,
	});
	const result = study.run({
		time: Date.parse("2024-01-02T23:00:00Z") / 1000,
		open: 300,
		high: 301,
		low: 300,
	});
	assert.equal(result[2], 310);
});

test("chart toolbar opens a default chart without passing its click event as a symbol", () => {
	assert.match(
		chartPage,
		/addChartButton\.addEventListener\('click', function \(\) \{ addChartWindow\(\); \}\)/,
	);
});

function createStudy(length2 = 20, scale = 1, resolution = "1", useRth = false) {
	const context = {
		new_sym() { throw new Error("Must not request other symbols"); },
		select_sym() { throw new Error("Must not switch data sources"); },
		setMinimumAdditionalDepth() { throw new Error("Must not request more chart history"); },
		resolution,
	};
	const study = new indicator.constructor();
	study.init(context);
	const values = [5, length2, scale, useRth];
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
	assert.equal(result.length, 12);
	assert.ok(result.every(Number.isNaN));
});

test("plots two symmetric hourly average range bands around the current hour open", () => {
	const study = createStudy(3);
	const baseHour = Date.parse("2024-01-02T14:30:00Z") / 1000;
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
	const baseHour = Date.parse("2024-01-02T14:30:00Z") / 1000;
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
	const start = Date.parse("2024-01-02T14:30:00Z") / 1000;
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
			"fourHour_upper5", "fourHour_lower5", "fourHour_upper20", "fourHour_lower20",
			"daily_upper5", "daily_lower5", "daily_upper20", "daily_lower20"],
	);
	assert.equal(indicator.metainfo.filledAreas.length, 6);
	assert.ok(indicator.metainfo.filledAreas.every((area) => area.type === "plot_plot"));
	assert.equal(indicator.metainfo.defaults.inputs.length1, 5);
	assert.equal(indicator.metainfo.defaults.inputs.length2, 20);
	assert.equal(indicator.metainfo.defaults.inputs.scale, 1);
	assert.equal(indicator.metainfo.inputs[3].name, "Use RTH hours (09:30–16:14 ET)");
	assert.equal(indicator.metainfo.defaults.inputs.useRth, false);
});

test("aggregates 4-hour ranges from loaded hourly bars and anchors them to the current 4-hour open", () => {
	const study = createStudy(3, 1, "60");
	const base = Date.parse("2024-01-02T14:30:00Z") / 1000;
	let result;

	for (let bucket = 0; bucket <= 7; bucket += 1) {
		const open = 1000 + bucket * 100;
		const range = bucket + 1;
		const dayOffset = Math.floor(bucket / 2) * 86400;
		const sessionPeriod = bucket % 2 * 4 * 3600;
		result = study.run({
			time: base + dayOffset + sessionPeriod,
			open,
			high: open + range,
			low: open,
		});
	}

	assert.equal(result[4], 1705);
	assert.equal(result[5], 1695);
	assert.equal(result[6], 1706);
	assert.equal(result[7], 1694);
});

test("keeps RTH bands blank on chart resolutions above one hour", () => {
	const study = createStudy(1, 1, "240");
	const base = Date.parse("2024-01-02T14:30:00Z") / 1000;
	study.run({ time: base, open: 100, high: 102, low: 98 });
	study.run({ time: base + 4 * 3600, open: 200, high: 203, low: 197 });
	const result = study.run({ time: base + 8 * 3600, open: 300, high: 305, low: 295 });

	assert.ok(result.slice(0, 4).every(Number.isNaN));
	assert.ok(result.slice(4).every(Number.isNaN));
});

test("ignores extended-hours bars when accumulating the RTH bands", () => {
	const study = createStudy(1, 1, "60", true);
	const bars = [
		["2024-01-02T14:00:00Z", 100, 1000],
		["2024-01-02T14:30:00Z", 100, 110],
		["2024-01-02T15:30:00Z", 100, 105],
		["2024-01-02T18:30:00Z", 100, 107],
		["2024-01-02T21:15:00Z", 100, 5000],
		["2024-01-03T14:30:00Z", 200, 200],
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

	assert.equal(result[2], 207);
	assert.equal(result[3], 193);
	assert.equal(result[6], 207);
	assert.equal(result[7], 193);
});

test("RTH indicator includes 16:14 but excludes the 16:15 bar", () => {
	const study = createStudy(1, 1, "1", true);
	study.run({
		time: Date.parse("2024-01-02T14:30:00Z") / 1000,
		open: 90,
		high: 95,
		low: 85,
	});
	study.run({
		time: Date.parse("2024-01-03T14:30:00Z") / 1000,
		open: 100,
		high: 120,
		low: 100,
	});
	study.run({
		time: Date.parse("2024-01-03T21:14:00Z") / 1000,
		open: 110,
		high: 130,
		low: 100,
	});
	study.run({
		time: Date.parse("2024-01-03T21:15:00Z") / 1000,
		open: 110,
		high: 10000,
		low: 1,
	});
	const result = study.run({
		time: Date.parse("2024-01-04T14:30:00Z") / 1000,
		open: 200,
		high: 201,
		low: 200,
	});

	assert.equal(result[10], 230);
	assert.equal(result[11], 170);
});

test("daily bands use completed regular-session ranges and the current RTH open", () => {
	const study = createStudy(1, 1, "60", true);
	let result;

	const tradingDays = [
		"2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05",
		"2024-01-08", "2024-01-09", "2024-01-10",
	];
	tradingDays.forEach((date, day) => {
		const open = 1000 + day * 100;
		const range = day + 1;
		result = study.run({
			time: Date.parse(`${date}T14:30:00Z`) / 1000,
			open,
			high: open + range,
			low: open,
		});
	});

	assert.equal(result[8], 1604);
	assert.equal(result[9], 1596);
	assert.equal(result[10], 1606);
	assert.equal(result[11], 1594);
});

test("RTH hourly and 4-hour anchors follow the New York session through daylight saving", () => {
	const summer = createStudy(1, 1, "60", true);
	summer.run({
		time: Date.parse("2024-07-01T13:30:00Z") / 1000,
		open: 100,
		high: 120,
		low: 100,
	});
	summer.run({
		time: Date.parse("2024-07-02T13:30:00Z") / 1000,
		open: 150,
		high: 151,
		low: 150,
	});
	const result = summer.run({
		time: Date.parse("2024-07-02T17:30:00Z") / 1000,
		open: 200,
		high: 201,
		low: 200,
	});
	assert.equal(result[2], 201);
	assert.equal(result[6], 201);
});

test("registers the updated study and replaces the previous saved study name", () => {
	assert.equal(indicator.name, "RTH Hourly, 4-Hour & Daily Range Bands");
	assert.match(chartPage, /RTH Hourly, 4-Hour & Daily Range Bands/);
	assert.match(chartPage, /NY 18:00 Hourly & 4-Hour Range Bands/);
});
