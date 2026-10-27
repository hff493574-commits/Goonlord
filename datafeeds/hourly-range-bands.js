// Calculates hourly, 4-hour, and daily range bands from the chart's loaded bars.
(function (global) {
	"use strict";

	var name = "RTH Hourly, 4-Hour & Daily Range Bands";
	var sessionTimezone = "America/New_York";
	var sessionDateFormatter = new Intl.DateTimeFormat("en-US", {
		timeZone: sessionTimezone,
		weekday: "short",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	var plotInfo = {
		hour_upper5: { title: "Hourly upper 5-period average" },
		hour_lower5: { title: "Hourly lower 5-period average" },
		hour_upper20: { title: "Hourly upper 20-period average" },
		hour_lower20: { title: "Hourly lower 20-period average" },
		fourHour_upper5: { title: "4-hour upper 5-period average" },
		fourHour_lower5: { title: "4-hour lower 5-period average" },
		fourHour_upper20: { title: "4-hour upper 20-period average" },
		fourHour_lower20: { title: "4-hour lower 20-period average" },
		daily_upper5: { title: "Daily upper 5-period average" },
		daily_lower5: { title: "Daily lower 5-period average" },
		daily_upper20: { title: "Daily upper 20-period average" },
		daily_lower20: { title: "Daily lower 20-period average" },
	};
	var plots = [
		{ id: "hour_upper5", type: "line" },
		{ id: "hour_lower5", type: "line" },
		{ id: "hour_upper20", type: "line" },
		{ id: "hour_lower20", type: "line" },
		{ id: "fourHour_upper5", type: "line" },
		{ id: "fourHour_lower5", type: "line" },
		{ id: "fourHour_upper20", type: "line" },
		{ id: "fourHour_lower20", type: "line" },
		{ id: "daily_upper5", type: "line" },
		{ id: "daily_lower5", type: "line" },
		{ id: "daily_upper20", type: "line" },
		{ id: "daily_lower20", type: "line" },
	];
	var defaults = {
		hour_upper5: lineStyle("#42A5F5", 2),
		hour_lower5: lineStyle("#42A5F5", 2),
		hour_upper20: lineStyle("#AB47BC", 1),
		hour_lower20: lineStyle("#AB47BC", 1),
		fourHour_upper5: lineStyle("#26A69A", 2),
		fourHour_lower5: lineStyle("#26A69A", 2),
		fourHour_upper20: lineStyle("#FF7043", 1),
		fourHour_lower20: lineStyle("#FF7043", 1),
		daily_upper5: lineStyle("#FFD54F", 2),
		daily_lower5: lineStyle("#FFD54F", 2),
		daily_upper20: lineStyle("#EC407A", 1),
		daily_lower20: lineStyle("#EC407A", 1),
	};
	var filledAreas = [
		{ id: "hour_upper_zone", objAId: "hour_upper5", objBId: "hour_upper20", title: "Hourly upper range zone", type: "plot_plot" },
		{ id: "hour_lower_zone", objAId: "hour_lower5", objBId: "hour_lower20", title: "Hourly lower range zone", type: "plot_plot" },
		{ id: "fourHour_upper_zone", objAId: "fourHour_upper5", objBId: "fourHour_upper20", title: "4-hour upper range zone", type: "plot_plot" },
		{ id: "fourHour_lower_zone", objAId: "fourHour_lower5", objBId: "fourHour_lower20", title: "4-hour lower range zone", type: "plot_plot" },
		{ id: "daily_upper_zone", objAId: "daily_upper5", objBId: "daily_upper20", title: "Daily upper range zone", type: "plot_plot" },
		{ id: "daily_lower_zone", objAId: "daily_lower5", objBId: "daily_lower20", title: "Daily lower range zone", type: "plot_plot" },
	];
	var filledAreasStyle = {
		hour_upper_zone: { color: "#42A5F5", transparency: 88, visible: true },
		hour_lower_zone: { color: "#AB47BC", transparency: 88, visible: true },
		fourHour_upper_zone: { color: "#26A69A", transparency: 88, visible: true },
		fourHour_lower_zone: { color: "#FF7043", transparency: 88, visible: true },
		daily_upper_zone: { color: "#FFD54F", transparency: 88, visible: true },
		daily_lower_zone: { color: "#EC407A", transparency: 88, visible: true },
	};
	var inputs = [
		{ id: "length1", name: "Range lookback 1", type: "integer", defval: 5, min: 1, max: 500 },
		{ id: "length2", name: "Range lookback 2", type: "integer", defval: 20, min: 1, max: 500 },
		{ id: "scale", name: "Range scale factor", type: "float", defval: 1, min: 0 },
		{ id: "useRth", name: "Use RTH hours (09:30–16:14 ET)", type: "bool", defval: false },
	];
	var metainfo = {
		_metainfoVersion: 53,
		id: "RTHHourly4HourDailyRangeBands@tv-basicstudies-1",
		name: name,
		description: name,
		shortDescription: "AHR Bands",
		isCustomIndicator: true,
		is_price_study: true,
		linkedToSeries: true,
		format: { type: "inherit" },
		inputs: inputs,
		plots: plots,
		styles: plotInfo,
		filledAreas: filledAreas,
		defaults: {
			styles: defaults,
			inputs: { length1: 5, length2: 20, scale: 1, useRth: false },
			filledAreasStyle: filledAreasStyle,
			precision: "default",
			palettes: {},
			bands: [],
			ohlcPlots: {},
			graphics: {},
		},
	};

	function lineStyle(color, width) {
		return { color: color, linewidth: width, linestyle: 0, plottype: 0, trackPrice: false, transparency: 0, visible: true, display: 15 };
	}

	function finite(value) {
		return typeof value === "number" && isFinite(value);
	}

	function makeIndicator(PineJS) {
		return {
			name: name,
			metainfo: metainfo,
			constructor: function () {
				this.init = function () {
					this._hour = newRangeState();
					this._fourHour = newRangeState();
					this._daily = newRangeState();
				};

				this.main = function (context, input) {
					var std = PineJS.Std;
					var timestamp = std.time(context);
					var open = std.open(context);
					var high = std.high(context);
					var low = std.low(context);
					if (!finite(timestamp) || !finite(open) || !finite(high) || !finite(low)) {
						return emptyPlots();
					}
					if (timestamp > 100000000000) { timestamp /= 1000; }
					var duration = periodSeconds(std.period(context));
					if (duration > 3600) { return emptyPlots(); }
					var useRth = Boolean(input(3));
					var session = useRth ? regularSession(timestamp) : extendedSession(timestamp);
					if (!session) {
						return this._hour.levels.concat(this._fourHour.levels, this._daily.levels);
					}
					var hourKey = useRth
						? session.date * 100 + Math.floor(session.minutesSinceOpen / 60)
						: Math.floor(timestamp / 3600);
					var fourHourKey = useRth
						? session.date * 10 + Math.floor(session.minutesSinceOpen / 240)
						: extendedFourHourPeriodKey(timestamp);
					var hourLevels = updateRange(
						this._hour, hourKey, open, high, low, input(0), input(1), input(2),
					);
					var fourHourLevels = updateRange(
						this._fourHour, fourHourKey, open, high, low, input(0), input(1), input(2),
					);
					var dailyLevels = updateRange(
						this._daily, session.date, open, high, low, input(0), input(1), input(2),
					);
					return hourLevels.concat(fourHourLevels, dailyLevels);
				};
			},
		};
	}

	function newRangeState() {
		return { key: null, high: NaN, low: NaN, ranges: [], skipFirst: true, levels: [NaN, NaN, NaN, NaN] };
	}

	function emptyPlots() {
		return [NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN];
	}

	function regularSession(timestamp) {
		var values = sessionDateParts(timestamp);
		var minutes = values.hour * 60 + values.minute;
		if ((values.weekday === "Sat" || values.weekday === "Sun") ||
			minutes < 9 * 60 + 30 || minutes >= 16 * 60 + 15) {
			return null;
		}
		return { date: values.date, minutesSinceOpen: minutes - (9 * 60 + 30) };
	}

	function extendedSession(timestamp) {
		var values = sessionDateParts(timestamp);
		var date = values.date;
		if (values.hour < 18) {
			var previousDay = new Date(Date.UTC(values.year, values.month - 1, values.day) - 86400000);
			date = previousDay.getUTCFullYear() * 10000 +
				(previousDay.getUTCMonth() + 1) * 100 + previousDay.getUTCDate();
		}
		return { date: date };
	}

	function sessionDateParts(timestamp) {
		var values = {};
		sessionDateFormatter.formatToParts(new Date(timestamp * 1000)).forEach(function (part) {
			values[part.type] = part.value;
		});
		values.year = Number(values.year);
		values.month = Number(values.month);
		values.day = Number(values.day);
		values.hour = Number(values.hour);
		values.minute = Number(values.minute);
		values.date = values.year * 10000 + values.month * 100 + values.day;
		return values;
	}

	function extendedFourHourPeriodKey(timestamp) {
		var values = sessionDateParts(timestamp);
		var dayTimestamp = Date.UTC(values.year, values.month - 1, values.day);
		var hour = values.hour;
		var startHour;
		if (hour >= 18) {
			startHour = hour < 22 ? 18 : 22;
		} else if (hour >= 14) {
			startHour = 14;
		} else if (hour >= 10) {
			startHour = 10;
		} else if (hour >= 6) {
			startHour = 6;
		} else if (hour >= 2) {
			startHour = 2;
		} else {
			dayTimestamp -= 86400000;
			startHour = 22;
		}
		var periodDate = new Date(dayTimestamp);
		var dateKey = periodDate.getUTCFullYear() * 10000 +
			(periodDate.getUTCMonth() + 1) * 100 + periodDate.getUTCDate();
		return dateKey * 100 + startHour;
	}

	function updateRange(state, key, open, high, low, length1, length2, scale) {
		if (state.key === null) {
			state.key = key;
			state.open = open;
			state.high = high;
			state.low = low;
			return state.levels;
		}
		if (key !== state.key) {
			if (!state.skipFirst) {
				state.ranges.unshift(state.high - state.low);
				state.ranges.length = Math.min(state.ranges.length, 500);
			}
			state.skipFirst = false;
			state.key = key;
			state.open = open;
			state.high = high;
			state.low = low;
			state.levels = [
				level(state.ranges, length1, scale, open, 1),
				level(state.ranges, length1, scale, open, -1),
				level(state.ranges, length2, scale, open, 1),
				level(state.ranges, length2, scale, open, -1),
			];
		} else {
			state.high = Math.max(state.high, high);
			state.low = Math.min(state.low, low);
		}
		return state.levels;
	}

	function level(ranges, length, scale, open, direction) {
		if (!finite(length) || length < 1 || ranges.length < length || !finite(scale)) { return NaN; }
		var total = 0;
		for (var index = 0; index < length; index += 1) {
			total += ranges[index];
		}
		return open + direction * (total / length * scale);
	}

	function periodSeconds(period) {
		var value = String(period);
		var seconds = /^(\d+)S$/.exec(value);
		if (seconds) { return Number(seconds[1]); }
		var minutes = /^(\d+)$/.exec(value);
		if (minutes) { return Number(minutes[1]) * 60; }
		if (value === "D" || value === "1D") { return 86400; }
		if (value === "W" || value === "1W") { return 604800; }
		if (value === "M" || value === "1M") { return 2592000; }
		return 86400;
	}

	global.RTHRangeBands = function (PineJS) {
		return makeIndicator(PineJS);
	};
})(window);
