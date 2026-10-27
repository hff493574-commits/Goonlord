(function (global) {
	"use strict";

	var supportedResolutions = ["1S", "5S", "15S", "30S", "1", "3", "5", "15", "30", "60", "240", "1D", "1W", "1M"];
	var streamCloseDelay = 1000;
	var maxCachedTicksPerSymbol = 150000;
	var secondsReplayLookbackMs = 2 * 60 * 60 * 1000;
	var regularHoursFormatter = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/New_York",
		weekday: "short",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	var sessionDateFormatter = new Intl.DateTimeFormat("en-US", {
		timeZone: "America/New_York",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});

	function isRegularHours(timestamp) {
		var parts = regularHoursFormatter.formatToParts(new Date(timestamp));
		var values = {};
		parts.forEach(function (part) { values[part.type] = part.value; });
		var weekday = values.weekday;
		var minutes = Number(values.hour) * 60 + Number(values.minute);
		return weekday !== "Sat" && weekday !== "Sun" && minutes >= 9 * 60 + 30 && minutes < 16 * 60 + 15;
	}

	function localSessionStart(timestamp) {
		var parts = regularHoursFormatter.formatToParts(new Date(timestamp));
		var values = {};
		parts.forEach(function (part) { values[part.type] = part.value; });
		var localMidnight = Date.UTC(
			Number(values.year),
			Number(values.month) - 1,
			Number(values.day),
			9,
			30,
		);
		var localParts = sessionDateFormatter.formatToParts(new Date(localMidnight));
		var localValues = {};
		localParts.forEach(function (part) { localValues[part.type] = part.value; });
		var representedAsUtc = Date.UTC(
			Number(localValues.year),
			Number(localValues.month) - 1,
			Number(localValues.day),
			Number(localValues.hour),
			Number(localValues.minute),
		);
		return localMidnight - (representedAsUtc - localMidnight);
	}

	function regularHoursLookbackMs(timestamp) {
		if (isRegularHours(timestamp)) { return 0; }
		var day = timestamp;
		for (var offset = 0; offset < 8; offset += 1) {
			var close = localSessionStart(day) + (6 * 60 * 60 + 45 * 60) * 1000;
			if (close <= timestamp && isRegularHours(close - 1000)) {
				return timestamp - close;
			}
			day = localSessionStart(day) - 24 * 60 * 60 * 1000;
		}
		return 3 * 24 * 60 * 60 * 1000;
	}

	function regularSessionBarTime(timestamp, duration) {
		var start = localSessionStart(timestamp);
		return start + Math.floor((timestamp - start) / duration) * duration;
	}

	function isIntradayResolution(resolution) {
		return /^(\d+)S$/.test(resolution) || /^\d+$/.test(resolution);
	}

	function isMinuteResolution(resolution) {
		return /^\d+$/.test(resolution);
	}

	function resolutionDurationMs(resolution) {
		var seconds = /^(\d+)S$/.exec(resolution);
		if (seconds) { return Number(seconds[1]) * 1000; }
		if (/^\d+$/.test(resolution)) { return Number(resolution) * 60 * 1000; }
		if (resolution === "1D") { return 24 * 60 * 60 * 1000; }
		if (resolution === "1W") { return 7 * 24 * 60 * 60 * 1000; }
		if (resolution === "1M") { return 30 * 24 * 60 * 60 * 1000; }
		return 60 * 1000;
	}

	function LSELiveDatafeed(baseUrl) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.subscriptions = new Map();
		this.streams = new Map();
		this.lastBars = new Map();
		this.barStates = new Map();
		this.tickHistory = new Map();
		this.lastPrices = new Map();
		this.lastPriceTimes = new Map();
		this.priceListeners = new Set();
	}

	LSELiveDatafeed.prototype.onReady = function (callback) {
		setTimeout(function () {
			callback({
				supports_search: true,
				supports_group_request: false,
				supports_marks: false,
				supports_timescale_marks: false,
				supports_time: true,
				supported_resolutions: supportedResolutions,
			});
		}, 0);
	};

	LSELiveDatafeed.prototype.searchSymbols = function (input, exchange, symbolType, callback) {
		var url = this.baseUrl + "/search?query=" + encodeURIComponent(input);
		fetch(url)
			.then(function (response) { return response.json(); })
			.then(callback)
			.catch(function () { callback([]); });
	};

	LSELiveDatafeed.prototype.resolveSymbol = function (symbolName, onResolve, onError) {
		var url = this.baseUrl + "/symbols?symbol=" + encodeURIComponent(symbolName);
		fetch(url)
			.then(function (response) {
				if (!response.ok) { throw new Error("Symbol not found"); }
				return response.json();
			})
			.then(onResolve)
			.catch(function (error) { onError(error.message); });
	};

	LSELiveDatafeed.prototype.getBars = function (symbolInfo, resolution, period, onResult, onError, sessionMode) {
		var requestedCountBack = Math.max(1, Number(period.countBack) || 1000);
		var queryCountBack = requestedCountBack;
		var from = period.from;
		var duration = resolutionDurationMs(resolution);
		var recentHistoryWindowMs = 3 * 24 * 60 * 60 * 1000;
		var recentRequest = period.to * 1000 >= Date.now() - recentHistoryWindowMs;
		var requestedWindowCount = Math.ceil((period.to - period.from) * 1000 / duration);
		if (isMinuteResolution(resolution) && recentRequest) {
			var minimumHistoryCount = Math.ceil(recentHistoryWindowMs / duration);
			queryCountBack = Math.max(queryCountBack, minimumHistoryCount);
			from = Math.min(from, Math.floor((period.to * 1000 - queryCountBack * duration) / 1000));
		}
		if (sessionMode === "RTH" && isIntradayResolution(resolution)) {
			queryCountBack = Math.ceil(
				requestedCountBack * 4 +
				(regularHoursLookbackMs(period.to * 1000) + 24 * 60 * 60 * 1000) / duration,
			);
			queryCountBack = Math.max(queryCountBack, requestedWindowCount);
			if (isMinuteResolution(resolution) && recentRequest) {
				queryCountBack = Math.max(queryCountBack, Math.ceil(recentHistoryWindowMs / duration));
			}
			queryCountBack = Math.min(queryCountBack, 5000);
			if (recentRequest) {
				from = Math.min(from, Math.floor((period.to * 1000 - queryCountBack * duration) / 1000));
			}
		}
		var query = new URLSearchParams({
			symbol: symbolInfo.ticker,
			resolution: resolution,
			from: String(from),
			to: String(period.to),
			countback: String(queryCountBack),
		});
		fetch(this.baseUrl + "/history?" + query.toString())
			.then(function (response) { return response.json(); })
			.then(function (payload) {
				if (payload.s === "error") { throw new Error(payload.errmsg); }
				if (payload.s === "no_data") {
					onResult([], { noData: true });
					return;
				}
				var bars = payload.t.map(function (time, index) {
					return {
						time: time * 1000,
						open: payload.o[index],
						high: payload.h[index],
						low: payload.l[index],
						close: payload.c[index],
						volume: payload.v[index],
					};
				});
				if (sessionMode === "RTH" && isIntradayResolution(resolution)) {
					bars = bars.filter(function (bar) { return isRegularHours(bar.time); });
				}
				bars = bars.filter(function (bar) {
					return bar.time >= from * 1000 && bar.time <= period.to * 1000;
				});
				if (bars.length) {
					var latestBar = bars[bars.length - 1];
					this.setLatestPrice(symbolInfo.ticker, latestBar.close, latestBar.time);
					var key = this.barKey(symbolInfo.ticker, resolution, sessionMode);
					var lastBar = latestBar;
					this.lastBars.set(key, lastBar);
					var state = this.barStates.get(key);
					if (!state || !state.currentBar || lastBar.time > state.currentBar.time) {
						state = {
							currentBar: lastBar,
							lastTickTime: replayCursor(lastBar.time),
							lastTickSequence: -1,
							symbol: symbolInfo.ticker,
							key: key,
							duration: resolutionDurationMs(resolution),
							intraday: isIntradayResolution(resolution),
							sessionMode: sessionMode,
							pendingBars: [],
						};
						this.barStates.set(key, state);
						this.replayCachedTicks(state);
					} else if (lastBar.time === state.currentBar.time) {
						state.currentBar = mergeHistoricalAndLiveBar(lastBar, state.currentBar);
						this.lastBars.set(key, state.currentBar);
					}
					var currentState = this.barStates.get(key);
					if (currentState) {
						this.lastBars.set(key, currentState.currentBar);
						bars = this.mergePendingBars(bars, currentState, period.to);
					}
				}
				onResult(bars, { noData: bars.length === 0 });
			}.bind(this))
			.catch(function (error) { onError(error.message); });
	};

	LSELiveDatafeed.prototype.subscribeBars = function (symbolInfo, resolution, onTick, listenerGuid, sessionMode) {
		this.unsubscribeBars(listenerGuid);
		var key = this.barKey(symbolInfo.ticker, resolution, sessionMode);
		var state = this.barStates.get(key);
		if (!state) {
			state = {
				currentBar: this.lastBars.get(key) || null,
				lastTickTime: initialTickCursor(resolution),
				lastTickSequence: -1,
				symbol: symbolInfo.ticker,
				key: key,
				duration: resolutionDurationMs(resolution),
				intraday: isIntradayResolution(resolution),
				sessionMode: sessionMode,
			};
			this.barStates.set(key, state);
			this.replayCachedTicks(state);
		}
		this.subscriptions.set(listenerGuid, {
			symbol: symbolInfo.ticker,
			key: key,
			onTick: onTick,
		});
		var pendingBars = state.pendingBars || [];
		state.pendingBars = [];
		if (pendingBars.length) {
			pendingBars.forEach(onTick);
		} else if (state.currentBar) {
			onTick(state.currentBar);
		}
		this.ensureStream(symbolInfo.ticker, state.lastTickTime);
	};

	LSELiveDatafeed.prototype.createClient = function (clientId) {
		var datafeed = this;
		var listenerIds = new Map();
		var activeSubscriptions = new Map();
		var prefix = "chart-" + String(clientId) + ":";
		var sessionMode = "ETH";
		return {
			onReady: datafeed.onReady.bind(datafeed),
			searchSymbols: datafeed.searchSymbols.bind(datafeed),
			resolveSymbol: function (symbolName, onResolve, onError) {
				datafeed.resolveSymbol(symbolName, function (symbolInfo) {
					if (sessionMode === "RTH") {
						symbolInfo.session = "0930-1615:23456";
						symbolInfo.timezone = "America/New_York";
					}
					onResolve(symbolInfo);
				}, onError);
			},
			getBars: function (symbolInfo, resolution, period, onResult, onError) {
				datafeed.getBars(symbolInfo, resolution, period, onResult, onError, sessionMode);
			},
			subscribeBars: function (symbolInfo, resolution, onTick, listenerGuid, onResetCacheNeeded) {
				var previousId = listenerIds.get(listenerGuid);
				if (previousId) { datafeed.unsubscribeBars(previousId); }
				var namespacedId = prefix + listenerGuid;
				listenerIds.set(listenerGuid, namespacedId);
				activeSubscriptions.set(listenerGuid, {
					symbolInfo: symbolInfo,
					resolution: resolution,
					onTick: onTick,
					onResetCacheNeeded: onResetCacheNeeded,
				});
				datafeed.subscribeBars(symbolInfo, resolution, onTick, namespacedId, sessionMode);
			},
			unsubscribeBars: function (listenerGuid) {
				var namespacedId = listenerIds.get(listenerGuid);
				if (!namespacedId) { return; }
				listenerIds.delete(listenerGuid);
				activeSubscriptions.delete(listenerGuid);
				datafeed.unsubscribeBars(namespacedId);
			},
			setRegularHoursEnabled: function (enabled) {
				var nextMode = enabled ? "RTH" : "ETH";
				if (sessionMode === nextMode) { return; }
				sessionMode = nextMode;
				var resetCallbacks = new Set();
				activeSubscriptions.forEach(function (subscription, listenerGuid) {
					if (typeof subscription.onResetCacheNeeded === "function") {
						resetCallbacks.add(subscription.onResetCacheNeeded);
					}
					var namespacedId = listenerIds.get(listenerGuid);
					if (namespacedId) { datafeed.unsubscribeBars(namespacedId); }
					datafeed.subscribeBars(
						subscription.symbolInfo,
						subscription.resolution,
						subscription.onTick,
						namespacedId,
						sessionMode,
					);
				});
				resetCallbacks.forEach(function (resetCache) { resetCache(); });
			},
			isRegularHoursEnabled: function () {
				return sessionMode === "RTH";
			},
		};
	};

	LSELiveDatafeed.prototype.unsubscribeBars = function (listenerGuid) {
		var subscription = this.subscriptions.get(listenerGuid);
		if (subscription) {
			this.subscriptions.delete(listenerGuid);
			var symbol = subscription.symbol;
			var stillSubscribed = Array.from(this.subscriptions.values()).some(function (item) {
				return item.symbol === symbol;
			});
			if (!stillSubscribed) {
				var stream = this.streams.get(symbol);
				if (stream && !stream.closeTimer) {
					stream.closeTimer = setTimeout(function () {
						var hasSubscriber = Array.from(this.subscriptions.values()).some(function (item) {
							return item.symbol === symbol;
						});
						if (!hasSubscriber && this.streams.get(symbol) === stream) {
							stream.source.close();
							this.streams.delete(symbol);
						}
					}.bind(this), streamCloseDelay);
				}
			}
		}
	};

	LSELiveDatafeed.prototype.ensureStream = function (symbol, replayFrom) {
		var existing = this.streams.get(symbol);
		if (existing) {
			if (existing.closeTimer) {
				clearTimeout(existing.closeTimer);
				existing.closeTimer = null;
			}
			return;
		}

		var streamUrl = new URL(this.baseUrl + "/stream");
		streamUrl.searchParams.set("symbol", symbol);
		streamUrl.searchParams.set("start", new Date(replayFrom).toISOString());
		var stream = { source: new EventSource(streamUrl.toString()), closeTimer: null };
		this.streams.set(symbol, stream);
		stream.source.onmessage = function (event) {
			var tick = JSON.parse(event.data);
			if (tick.error) {
				console.error("LSE live feed:", tick.error);
				return;
			}
			this.cacheTick(symbol, tick);
			var tickTime = Number(tick.timestamp_ms) || Number(tick.time) * 1000;
			this.setLatestPrice(symbol, Number(tick.price), tickTime);
			var activeKeys = new Set();
			this.subscriptions.forEach(function (subscription) {
				if (subscription.symbol === symbol) { activeKeys.add(subscription.key); }
			});
			var updatedBars = new Map();
			this.barStates.forEach(function (state, key) {
				if (state.symbol === symbol) {
					var bar = this.applyTick(state, state.duration, tick);
					if (bar) {
						updatedBars.set(key, bar);
						if (!activeKeys.has(key)) { this.queuePendingBar(state, bar); }
					}
				}
			}.bind(this));
			this.subscriptions.forEach(function (subscription) {
				if (subscription.symbol === symbol) {
					var bar = updatedBars.get(subscription.key);
					if (bar) { subscription.onTick(bar); }
				}
			}.bind(this));
		}.bind(this);
		stream.source.onerror = function () {
			console.warn("LSE live stream reconnecting for", symbol);
		};
	};

	LSELiveDatafeed.prototype.applyTick = function (state, duration, tick) {
		var tickTime = tick.timestamp_ms === undefined ? Number(tick.time) * 1000 : Number(tick.timestamp_ms);
		var tickSequence = Number.isSafeInteger(Number(tick.sequence)) ? Number(tick.sequence) : 0;
		var price = Number(tick.price);
		var volume = Number(tick.volume) || 0;
		if (!Number.isFinite(tickTime) || !Number.isFinite(price) || !Number.isFinite(duration) || duration <= 0) {
			return null;
		}
		if (state.sessionMode === "RTH" && state.intraday && !isRegularHours(tickTime)) {
			return null;
		}
		if (tickTime < state.lastTickTime ||
			(tickTime === state.lastTickTime && tickSequence <= state.lastTickSequence)) {
			return null;
		}
		var currentBar = state.currentBar;
		if (currentBar && tickTime < currentBar.time) { return null; }
		var barTime = state.sessionMode === "RTH" && state.intraday
			? regularSessionBarTime(tickTime, duration)
			: currentBar
			? currentBar.time + Math.floor((tickTime - currentBar.time) / duration) * duration
			: Math.floor(tickTime / duration) * duration;
		if (currentBar && barTime < currentBar.time) { return null; }
		state.lastTickTime = tickTime;
		state.lastTickSequence = tickSequence;

		if (!currentBar || barTime > currentBar.time) {
			currentBar = {
				time: barTime,
				open: price,
				high: price,
				low: price,
				close: price,
				volume: volume,
			};
		} else {
			currentBar = {
				time: currentBar.time,
				open: currentBar.open,
				high: Math.max(currentBar.high, price),
				low: Math.min(currentBar.low, price),
				close: price,
				volume: currentBar.volume + volume,
			};
		}
		state.currentBar = currentBar;
		this.lastBars.set(state.key, currentBar);
		return currentBar;
	};

	LSELiveDatafeed.prototype.cacheTick = function (symbol, tick) {
		var history = this.tickHistory.get(symbol);
		if (!history) {
			history = { ticks: [], start: 0 };
			this.tickHistory.set(symbol, history);
		}
		history.ticks.push(tick);
		if (history.ticks.length - history.start > maxCachedTicksPerSymbol) {
			history.start += 1;
			if (history.start >= 5000 && history.start * 2 >= history.ticks.length) {
				history.ticks = history.ticks.slice(history.start);
				history.start = 0;
			}
		}
	};

	LSELiveDatafeed.prototype.replayCachedTicks = function (state) {
		var history = this.tickHistory.get(state.symbol);
		if (!history) { return; }
		for (var index = history.start; index < history.ticks.length; index += 1) {
			var bar = this.applyTick(state, state.duration, history.ticks[index]);
			if (bar) { this.queuePendingBar(state, bar); }
		}
	};

	LSELiveDatafeed.prototype.queuePendingBar = function (state, bar) {
		if (!state.pendingBars) { state.pendingBars = []; }
		var lastIndex = state.pendingBars.length - 1;
		if (lastIndex >= 0 && state.pendingBars[lastIndex].time === bar.time) {
			state.pendingBars[lastIndex] = bar;
		} else {
			state.pendingBars.push(bar);
		}
	};

	LSELiveDatafeed.prototype.mergePendingBars = function (bars, state, periodEnd) {
		var merged = new Map();
		bars.forEach(function (bar) { merged.set(bar.time, bar); });
		var endTime = Number(periodEnd) * 1000;
		var pendingBars = state.pendingBars || [];
		var remaining = [];
		pendingBars.forEach(function (bar) {
			if (!Number.isFinite(endTime) || bar.time <= endTime) {
				merged.set(bar.time, merged.has(bar.time)
					? mergeHistoricalAndLiveBar(merged.get(bar.time), bar)
					: bar);
			} else {
				remaining.push(bar);
			}
		});
		if (state.currentBar && (!Number.isFinite(endTime) || state.currentBar.time <= endTime)) {
			merged.set(state.currentBar.time, merged.has(state.currentBar.time)
				? mergeHistoricalAndLiveBar(merged.get(state.currentBar.time), state.currentBar)
				: state.currentBar);
		}
		state.pendingBars = remaining;
		return Array.from(merged.values()).sort(function (left, right) {
			return left.time - right.time;
		});
	};

	function mergeHistoricalAndLiveBar(historicalBar, liveBar) {
		return {
			time: historicalBar.time,
			open: historicalBar.open,
			high: Math.max(historicalBar.high, liveBar.high),
			low: Math.min(historicalBar.low, liveBar.low),
			close: liveBar.close,
			volume: Math.max(historicalBar.volume, liveBar.volume),
		};
	}

	LSELiveDatafeed.prototype.barKey = function (symbol, resolution, sessionMode) {
		return symbol + ":" + resolution + ":" + (sessionMode || "ETH");
	};

	LSELiveDatafeed.prototype.getLastPrice = function (symbol) {
		return this.lastPrices.get(symbol);
	};

	LSELiveDatafeed.prototype.setLatestPrice = function (symbol, price, time) {
		if (!Number.isFinite(price) || !Number.isFinite(time)) { return false; }
		var previousTime = this.lastPriceTimes.get(symbol);
		if (previousTime !== undefined && time < previousTime) { return false; }
		this.lastPrices.set(symbol, price);
		this.lastPriceTimes.set(symbol, time);
		this.priceListeners.forEach(function (listener) {
			listener(symbol, price);
		});
		return true;
	};

	LSELiveDatafeed.prototype.subscribePriceUpdates = function (listener) {
		this.priceListeners.add(listener);
		return function () {
			this.priceListeners.delete(listener);
		}.bind(this);
	};

	function currentTickCursor() {
		return Date.now() - 1;
	}

	function initialTickCursor(resolution) {
		return /^(\d+)S$/.test(resolution)
			? Date.now() - secondsReplayLookbackMs
			: currentTickCursor();
	}

	function replayCursor(lastBarTime) {
		// Replay the active candle, while staying within the feed's 24-hour replay limit.
		var now = Date.now();
		var barTime = Number(lastBarTime);
		var replayFloor = now - 23 * 60 * 60 * 1000;
		return Math.max(Math.min(Number.isFinite(barTime) ? barTime : now, now), replayFloor) - 1000;
	}

	global.LSELiveDatafeed = LSELiveDatafeed;
})(window);