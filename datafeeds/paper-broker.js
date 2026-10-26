(function (global) {
	"use strict";

	var storageKey = "lse-paper-account-v1";
	var initialBalance = 100000;
	var orderStatus = { Canceled: 1, Filled: 2, Working: 6 };
	var orderType = { Market: 2 };
	var side = { Buy: 1, Sell: -1 };

	function contractValue(symbol) {
		var values = {
			"NQ.F": 20, "NASDAQ100.F": 20, "ES.F": 50,
			"SP500.F": 50, "GC.F": 100, "GOLD.F": 100,
		};
		return values[symbol.toUpperCase()] || 1;
	}

	function minTick(symbol) {
		var ticks = {
			"NQ.F": 0.25, "NASDAQ100.F": 0.25, "ES.F": 0.25,
			"SP500.F": 0.25, "GC.F": 0.1, "GOLD.F": 0.1,
		};
		return ticks[symbol.toUpperCase()] || 0.01;
	}

	function readAccount() {
		var saved = global.localStorage.getItem(storageKey);
		if (!saved) {
			return { balance: initialBalance, positions: [], history: [], nextOrderId: 1 };
		}
		var account = JSON.parse(saved);
		if (!account || !Number.isFinite(account.balance) || !Array.isArray(account.positions) ||
			!account.positions.every(function (position) {
			return position && typeof position.symbol === "string" && Number.isFinite(position.qty) &&
					Number.isFinite(position.avgPrice) && Number.isFinite(position.multiplier) &&
					position.multiplier > 0;
			}) || !Array.isArray(account.history) ||
			!Number.isInteger(account.nextOrderId) || account.nextOrderId < 1) {
			throw new Error("Saved paper-trading account data is invalid.");
		}
		return account;
	}

	function PaperBroker(host, datafeed) {
		this.host = host;
		this.datafeed = datafeed;
		this.account = readAccount();
		this.balanceValue = host
			? host.factory.createWatchedValue(this.account.balance)
			: { value: this.account.balance, setValue: function (value) { this.value = value; } };
		this.equityValue = host
			? host.factory.createWatchedValue(this.account.balance)
			: { value: this.account.balance, setValue: function (value) { this.value = value; } };
		this.accountListeners = new Set();
		this.unsubscribePrices = datafeed.subscribePriceUpdates(this.onPriceUpdate.bind(this));
		this.refreshEquity();
	}

	PaperBroker.prototype.accountsMetainfo = function () {
		return Promise.resolve([{
			id: "paper",
			name: "Paper Trading",
			currency: "USD",
			currencySign: "$",
		}]);
	};

	PaperBroker.prototype.currentAccount = function () {
		return "paper";
	};

	PaperBroker.prototype.isTradable = function () {
		return Promise.resolve(true);
	};

	PaperBroker.prototype.connectionStatus = function () {
		return 1;
	};

	PaperBroker.prototype.orders = function () {
		return Promise.resolve(this.account.history.slice(0, 100));
	};

	PaperBroker.prototype.getSnapshot = function () {
		var positions = this.account.positions.filter(function (position) {
			return position.qty !== 0;
		}).map(function (position) {
			var price = this.datafeed.getLastPrice(position.symbol);
			var unrealized = Number.isFinite(price)
				? (price - position.avgPrice) * position.qty * position.multiplier
				: 0;
			return {
				symbol: position.symbol,
				qty: position.qty,
				avgPrice: position.avgPrice,
				markPrice: Number.isFinite(price) ? price : null,
				unrealized: unrealized,
			};
		}.bind(this));
		var unrealized = positions.reduce(function (total, position) {
			return total + position.unrealized;
		}, 0);
		return {
			balance: this.account.balance,
			equity: this.account.balance + unrealized,
			unrealized: unrealized,
			positions: positions,
			history: this.account.history.slice(0, 100),
		};
	};

	PaperBroker.prototype.subscribeAccount = function (listener) {
		this.accountListeners.add(listener);
		listener(this.getSnapshot());
		return function () {
			this.accountListeners.delete(listener);
		}.bind(this);
	};

	PaperBroker.prototype.notifyAccount = function () {
		var snapshot = this.getSnapshot();
		this.accountListeners.forEach(function (listener) {
			listener(snapshot);
		});
	};

	PaperBroker.prototype.positions = function () {
		return Promise.resolve(this.account.positions
			.filter(function (position) { return position.qty !== 0; })
			.map(function (position) {
				var price = this.datafeed.getLastPrice(position.symbol);
				return {
					id: position.symbol,
					symbol: position.symbol,
					qty: Math.abs(position.qty),
					side: position.qty > 0 ? side.Buy : side.Sell,
					avgPrice: position.avgPrice,
					pl: Number.isFinite(price)
						? (price - position.avgPrice) * position.qty * position.multiplier
						: 0,
				};
			}.bind(this)));
	};

	PaperBroker.prototype.executions = function () {
		return Promise.resolve([]);
	};

	PaperBroker.prototype.symbolInfo = function (symbol) {
		return Promise.resolve({
			qty: { min: 1, max: 1000, step: 1 },
			pipValue: contractValue(symbol),
			pipSize: minTick(symbol),
			minTick: minTick(symbol),
			description: "Simulated paper-trading instrument",
			currency: "USD",
			allowedOrderTypes: [orderType.Market],
		});
	};

	PaperBroker.prototype.accountManagerInfo = function () {
		return {
			accountTitle: "Paper Trading",
			summary: [{
				text: "Balance", wValue: this.balanceValue, formatter: "fixedInCurrency", isDefault: true,
			}, {
				text: "Equity", wValue: this.equityValue, formatter: "fixedInCurrency", isDefault: true,
			}],
			orderColumns: [
				{ id: "symbol", label: "Symbol", dataFields: ["symbol"] },
				{ id: "side", label: "Side", dataFields: ["side"], formatter: "side" },
				{ id: "qty", label: "Quantity", dataFields: ["qty"], formatter: "formatQuantity" },
				{ id: "avgPrice", label: "Fill price", dataFields: ["avgPrice"], formatter: "formatPrice" },
				{ id: "status", label: "Status", dataFields: ["status"], formatter: "status" },
			],
			historyColumns: [
				{ id: "symbol", label: "Symbol", dataFields: ["symbol"] },
				{ id: "side", label: "Side", dataFields: ["side"], formatter: "side" },
				{ id: "qty", label: "Quantity", dataFields: ["qty"], formatter: "formatQuantity" },
				{ id: "avgPrice", label: "Fill price", dataFields: ["avgPrice"], formatter: "formatPrice" },
				{ id: "status", label: "Status", dataFields: ["status"], formatter: "status" },
			],
			positionColumns: [
				{ id: "symbol", label: "Symbol", dataFields: ["symbol"] },
				{ id: "side", label: "Side", dataFields: ["side"], formatter: "side" },
				{ id: "qty", label: "Quantity", dataFields: ["qty"], formatter: "formatQuantity" },
				{ id: "avgPrice", label: "Average price", dataFields: ["avgPrice"], formatter: "formatPrice" },
				{ id: "pl", label: "P&L", dataFields: ["pl"], formatter: "profit" },
			],
			pages: [],
		};
	};

	PaperBroker.prototype.chartContextMenuActions = function () {
		return Promise.resolve([]);
	};

	PaperBroker.prototype.ordersHistory = function () {
		return Promise.resolve(this.account.history.slice());
	};

	PaperBroker.prototype.placeOrder = function (order) {
		if (order.type !== orderType.Market) {
			return Promise.reject(new Error("Paper Trading currently supports market orders only."));
		}
		var quantity = Number(order.qty);
		if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000) {
			return Promise.reject(new Error("Order quantity must be between 0 and 1,000."));
		}
		if (order.side !== side.Buy && order.side !== side.Sell) {
			return Promise.reject(new Error("Order side must be buy or sell."));
		}

		var quote = order.currentQuotes || {};
		var quotedPrice = order.side === side.Buy ? quote.ask : quote.bid;
		var price = Number(quotedPrice) || this.datafeed.getLastPrice(order.symbol);
		if (!Number.isFinite(price) || price <= 0) {
			return Promise.reject(new Error("No current price is available to fill this paper order."));
		}

		var signedQuantity = order.side * quantity;
		var multiplier = contractValue(order.symbol);
		var existing = this.account.positions.find(function (position) {
			return position.symbol === order.symbol;
		});
		if (!existing) {
			existing = { symbol: order.symbol, qty: 0, avgPrice: 0, multiplier: multiplier };
			this.account.positions.push(existing);
		}
		var oldQuantity = existing.qty;
		if (oldQuantity && Math.sign(oldQuantity) !== Math.sign(signedQuantity)) {
			var closedQuantity = Math.min(Math.abs(oldQuantity), quantity);
			this.account.balance += (
				(price - existing.avgPrice) * closedQuantity * Math.sign(oldQuantity) * multiplier
			);
		}
		var nextQuantity = oldQuantity + signedQuantity;
		if (!oldQuantity || Math.sign(oldQuantity) === Math.sign(signedQuantity)) {
			existing.avgPrice = (
				Math.abs(oldQuantity) * existing.avgPrice + quantity * price
			) / (Math.abs(oldQuantity) + quantity);
		} else if (nextQuantity && Math.sign(nextQuantity) !== Math.sign(oldQuantity)) {
			existing.avgPrice = price;
		}
		existing.qty = nextQuantity;
		if (!nextQuantity) {
			this.account.positions = this.account.positions.filter(function (position) {
				return position !== existing;
			});
		}

		var orderId = String(this.account.nextOrderId++);
		var fill = {
			id: orderId,
			symbol: order.symbol,
			type: orderType.Market,
			side: order.side,
			qty: quantity,
			filledQty: quantity,
			avgPrice: price,
			status: orderStatus.Filled,
			updateTime: Date.now(),
		};
		this.account.history.unshift(fill);
		this.account.history = this.account.history.slice(0, 2000);
		this.persist();
		this.balanceValue.setValue(this.account.balance);
		this.refreshEquity();
		this.updatePosition(order.symbol, existing, price);
		if (this.host) { this.host.orderUpdate(fill); }
		this.notifyAccount();
		return Promise.resolve({ orderId: orderId });
	};

	PaperBroker.prototype.updatePosition = function (symbol, position, price) {
		if (!this.host) { return; }
		if (!position.qty) {
			this.host.positionUpdate({
				id: symbol, symbol: symbol, qty: 0, side: side.Buy, avgPrice: price,
			});
			return;
		}
		this.host.positionUpdate({
			id: symbol,
			symbol: symbol,
			qty: Math.abs(position.qty),
			side: position.qty > 0 ? side.Buy : side.Sell,
			avgPrice: position.avgPrice,
			pl: (price - position.avgPrice) * position.qty * position.multiplier,
		});
	};

	PaperBroker.prototype.onPriceUpdate = function (symbol, price) {
		var position = this.account.positions.find(function (item) {
			return item.symbol === symbol && item.qty !== 0;
		});
		this.refreshEquity();
		if (position && this.host) {
			var unrealized = (price - position.avgPrice) * position.qty * position.multiplier;
			this.host.plUpdate(position.symbol, unrealized);
			this.updatePosition(symbol, position, price);
		}
		this.notifyAccount();
	};

	PaperBroker.prototype.refreshEquity = function () {
		var snapshot = this.getSnapshot();
		this.equityValue.setValue(snapshot.equity);
	};

	PaperBroker.prototype.closePosition = function (positionId, amount) {
		return this.positions().then(function (positions) {
			var position = positions.find(function (item) { return item.id === positionId; });
			if (!position) { throw new Error("Paper position not found."); }
			return this.placeOrder({
				symbol: position.symbol,
				type: orderType.Market,
				side: position.side === side.Buy ? side.Sell : side.Buy,
				qty: Math.min(Number(amount) || position.qty, position.qty),
				isClose: true,
			}).then(function () {});
		}.bind(this));
	};

	PaperBroker.prototype.persist = function () {
		global.localStorage.setItem(storageKey, JSON.stringify(this.account));
	};

	global.LSEPaperBroker = PaperBroker;
})(window);
