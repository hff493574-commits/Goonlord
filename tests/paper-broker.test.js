"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const brokerSource = fs.readFileSync(path.join(__dirname, "../datafeeds/paper-broker.js"), "utf8");

function createBroker(savedValue) {
	const storage = new Map(savedValue ? [["lse-paper-account-v1", savedValue]] : []);
	const browser = {
		localStorage: {
			getItem: (key) => storage.get(key) || null,
			setItem: (key, value) => storage.set(key, value),
		},
	};
	vm.runInNewContext(brokerSource, { window: browser });

	const host = {
		factory: {
			createWatchedValue(value) {
				return {
					value,
					setValue(nextValue) { this.value = nextValue; },
				};
			},
		},
		orderUpdates: [],
		positionUpdates: [],
		plUpdates: [],
		orderUpdate(order) { this.orderUpdates.push(order); },
		positionUpdate(position) { this.positionUpdates.push(position); },
		plUpdate(id, pl) { this.plUpdates.push({ id, pl }); },
	};
	const datafeed = {
		price: undefined,
		listeners: new Set(),
		getLastPrice() { return this.price; },
		subscribePriceUpdates(listener) {
			this.listeners.add(listener);
			return () => this.listeners.delete(listener);
		},
	};
	const broker = new browser.LSEPaperBroker(host, datafeed);
	return { broker, browser, datafeed, host, storage };
}

test("starts with $100,000 and restores account state from local storage", async () => {
	const first = createBroker();
	assert.deepEqual(JSON.parse(JSON.stringify(await first.broker.accountsMetainfo())), [{
		id: "paper",
		name: "Paper Trading",
		currency: "USD",
		currencySign: "$",
	}]);
	assert.equal(first.broker.balanceValue.value, 100000);

	await first.broker.placeOrder({
		symbol: "NQ.F", type: 2, side: 1, qty: 1, currentQuotes: { ask: 20000 },
	});
	const second = createBroker(first.storage.get("lse-paper-account-v1"));
	assert.equal(second.broker.balanceValue.value, 100000);
	assert.equal((await second.broker.positions())[0].qty, 1);
	assert.equal((await second.broker.ordersHistory()).length, 1);
});

test("nets positions, realizes futures P&L, and closes through market fills", async () => {
	const { broker, datafeed, host } = createBroker();
	await broker.placeOrder({
		symbol: "NQ.F", type: 2, side: 1, qty: 2, currentQuotes: { ask: 100 },
	});
	await broker.placeOrder({
		symbol: "NQ.F", type: 2, side: -1, qty: 1, currentQuotes: { bid: 110 },
	});
	assert.equal(broker.balanceValue.value, 100200);
	assert.deepEqual(
		JSON.parse(JSON.stringify((await broker.positions()).map(({ qty, avgPrice }) => ({ qty, avgPrice })))),
		[{ qty: 1, avgPrice: 100 }],
	);

	datafeed.price = 90;
	await broker.closePosition("NQ.F");
	assert.equal(broker.balanceValue.value, 100000);
	assert.equal((await broker.positions()).length, 0);
	assert.equal(host.orderUpdates.length, 3);
	assert.equal(host.positionUpdates.at(-1).qty, 0);
});

test("rejects missing prices and quantities outside supported limits", async () => {
	const { broker } = createBroker();
	await assert.rejects(
		broker.placeOrder({ symbol: "NQ.F", type: 2, side: 1, qty: 1 }),
		/No current price/,
	);
	await assert.rejects(
		broker.placeOrder({ symbol: "NQ.F", type: 2, side: 1, qty: 1001, currentQuotes: { ask: 1 } }),
		/quantity must be between/,
	);
});

test("marks equity and position P&L from live datafeed price updates", async () => {
	const { broker, datafeed, host } = createBroker();
	await broker.placeOrder({
		symbol: "NQ.F", type: 2, side: 1, qty: 1, currentQuotes: { ask: 100 },
	});
	datafeed.price = 105;
	datafeed.listeners.forEach((listener) => listener("NQ.F", 105));

	assert.equal(broker.equityValue.value, 100100);
	assert.deepEqual(host.plUpdates.at(-1), { id: "NQ.F", pl: 100 });
});

test("supports a standalone paper panel without the Trading Platform broker host", async () => {
	const { browser, datafeed } = createBroker();
	const broker = new browser.LSEPaperBroker(null, datafeed);
	const snapshots = [];
	const unsubscribe = broker.subscribeAccount((snapshot) => snapshots.push(snapshot));
	await broker.placeOrder({
		symbol: "NQ.F", type: 2, side: 1, qty: 1, currentQuotes: { ask: 20000 },
	});
	datafeed.price = 20001;
	datafeed.listeners.forEach((listener) => listener("NQ.F", 20001));

	assert.equal(snapshots.at(-1).positions[0].markPrice, 20001);
	assert.equal(snapshots.at(-1).unrealized, 20);
	assert.equal(snapshots.at(-1).equity, 100020);
	unsubscribe();
});
