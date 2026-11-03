/**
 * client.js acceptance test — no DSH packages, no browser, no build step.
 *
 * It reconstructs the two things the Web shell gives a plugin bundle:
 *   1. `window.__ModuleLoader__.load({ id, factory })` — the registration sink;
 *   2. `require` — the shell's lazy CJS seed table (react, jsx-runtime, ...).
 * Then it materializes the factory and drives the exported `apply()` against a
 * fake `slots` service, plus renders the exported components with a stub React
 * so the empty/garbage/real data paths are asserted end to end.
 *
 * The Host global key is read from the bundle's own export, never hardcoded here,
 * so this test also proves the key the Lead has to inject.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLIENT_PATH = join(ROOT, "client.js");
const SOURCE = readFileSync(CLIENT_PATH, "utf8");

/** Every character that silently corrupts a module id or specifier. */
const INVISIBLE = /[\u200B-\u200F\u2060\uFEFF\u00AD]/;

//#region stubs
/** Stub React: createElement builds a plain tree; the two hooks used are inert. */
function createFakeReact() {
	const effects = [];
	const fake = {
		createElement(type, props, ...children) {
			return {
				type,
				props: props === null || props === undefined ? {} : props,
				children,
			};
		},
		useState(initial) {
			const value = typeof initial === "function" ? initial() : initial;
			return [value, () => undefined];
		},
		useEffect(fn) {
			effects.push(fn);
			return undefined;
		},
	};
	return { fake, effects };
}

/** Load client.js into a fresh VM context and return the harness. */
function loadBundle() {
	const loadCalls = [];
	const requireCalls = [];
	const warnings = [];
	const { fake: fakeReact, effects } = createFakeReact();

	const window = {
		__ModuleLoader__: {
			load(registration) {
				loadCalls.push(registration);
			},
		},
		setInterval() {
			return 1;
		},
		clearInterval() {
			return undefined;
		},
		addEventListener() {
			return undefined;
		},
		removeEventListener() {
			return undefined;
		},
	};

	const sandbox = {
		window,
		console: {
			warn(...args) {
				warnings.push(args);
			},
			error(...args) {
				warnings.push(args);
			},
			log() {
				return undefined;
			},
		},
	};
	const context = vm.createContext(sandbox);
	vm.runInContext(SOURCE, context, { filename: "client.js" });

	const requireStub = (specifier) => {
		requireCalls.push(specifier);
		if (specifier === "react") return fakeReact;
		if (specifier === "react/jsx-runtime") {
			return {
				jsx: fakeReact.createElement,
				jsxs: fakeReact.createElement,
				Fragment: "Fragment",
			};
		}
		if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return {};
		throw new Error(`test require: unexpected specifier ${JSON.stringify(specifier)}`);
	};

	const harness = {
		loadCalls,
		requireCalls,
		warnings,
		window,
		effects,
		context,
		exports: undefined,
		materialize() {
			assert.equal(loadCalls.length, 1, "bundle must register exactly one factory");
			harness.exports = loadCalls[0].factory(requireStub);
			return harness.exports;
		},
		/** Publish a Host snapshot under the bundle's own global key. */
		setGlobal(value) {
			harness.window[harness.exports.GLOBAL_KEY] = value;
			return value;
		},
	};
	return harness;
}

/** Load + materialize + publish Host data in one step. */
function bundleWith(data) {
	const harness = loadBundle();
	const exportsObject = harness.materialize();
	if (data !== undefined) harness.setGlobal(data);
	return { harness, exports: exportsObject };
}

/** Flatten a stub element tree into text, rendering function components. */
function textOf(node) {
	if (node === null || node === undefined || node === false) return "";
	if (typeof node === "string") return node;
	if (typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (typeof node === "object") {
		if (typeof node.type === "function") return textOf(node.type(node.props));
		return textOf(node.children);
	}
	return "";
}

/** Fake `slots` service recording every registration. */
function createFakeSlots(options = {}) {
	const registered = [];
	const injected = [];
	return {
		registered,
		injected,
		inject(name, callback) {
			injected.push(name);
			if (options.throwOnInject === true) throw new Error("inject exploded");
			return callback();
		},
		register(slotOptions, component) {
			if (options.throwOnRegister === true) throw new Error("register exploded");
			registered.push({ slotOptions, component });
			return () => undefined;
		},
	};
}
//#endregion

test("bundle registers itself under the id the contract requires", () => {
	const harness = loadBundle();
	assert.equal(harness.loadCalls.length, 1, "exactly one __ModuleLoader__.load call");
	const registration = harness.loadCalls[0];
	assert.equal(registration.id, "dsh-a2a");
	assert.equal(typeof registration.factory, "function");
	// The literal must be plain ASCII (U+200D and friends silently break module ids).
	assert.equal(INVISIBLE.test(registration.id), false, "id must not contain invisible characters");
	assert.ok(/^[\x20-\x7e]+$/.test(registration.id), "id must be pure ASCII");
});

test("source carries no invisible characters anywhere", () => {
	const offenders = [];
	for (let index = 0; index < SOURCE.length; index += 1) {
		if (INVISIBLE.test(SOURCE[index])) offenders.push(index);
	}
	assert.deepEqual(
		offenders.map((index) => {
			const line = SOURCE.slice(0, index).split("\n").length;
			return line;
		}),
		[],
		"client.js must not contain zero-width or soft-hyphen characters"
	);
});

test("source is a browser bundle, not an ES module", () => {
	assert.equal(/^\s*import\s/m.test(SOURCE), false, "no static import statement");
	assert.equal(/^\s*export\s/m.test(SOURCE), false, "no export statement");
	assert.equal(/\bimport\s*\(/.test(SOURCE), false, "no dynamic import()");
	assert.equal(/^\s*require\s*\(/m.test(SOURCE), false, "no bare require() outside the factory");
	assert.ok(SOURCE.includes("window.__ModuleLoader__.load("), "registers through the shell facade");
});

test("factory only requires modules from the shell seed table", () => {
	// The exact table `OZ()` returns in the web shell's boot bundle.
	const SEED_MODULES = [
		"react",
		"react/jsx-runtime",
		"react-dom",
		"react-dom/client",
		"@deepseek-ai/cordis",
		"zod",
		"@tanstack/react-virtual",
		"@deepseek-ai/dsh-client-store",
		"@deepseek-ai/dsh-client-ui-slots",
		"@deepseek-ai/dsh-client-ui-primitives",
		"@deepseek-ai/dsh-client-ui-dockkit",
	];
	const harness = loadBundle();
	harness.materialize();
	assert.ok(harness.requireCalls.length > 0, "factory must require at least react");
	assert.equal(harness.requireCalls[0], "react");
	for (const specifier of harness.requireCalls) {
		assert.ok(SEED_MODULES.includes(specifier), `${specifier} is not in the seed table`);
		assert.equal(INVISIBLE.test(specifier), false, `${JSON.stringify(specifier)} contains invisible characters`);
	}
});

test("factory exports the plugin surface", () => {
	const exportsObject = loadBundle().materialize();
	assert.equal(typeof exportsObject.apply, "function");
	assert.deepEqual([...exportsObject.inject], ["slots"]);
	for (const name of ["setDataSource", "readSnapshot", "currentSnapshot", "subscribeGroups", "formatTime"]) {
		assert.equal(typeof exportsObject[name], "function", `${name} must be exported`);
	}
	for (const name of ["GroupsPanel", "GroupsSidebarIcon", "GroupCard", "EmptyState"]) {
		assert.equal(typeof exportsObject[name], "function", `${name} must be exported`);
	}
	assert.equal(exportsObject.PANEL_ID, "a2a-groups");
	assert.equal(INVISIBLE.test(exportsObject.GLOBAL_KEY), false, "global key must be plain ASCII");
	assert.ok(exportsObject.GLOBAL_KEY.startsWith("__") && exportsObject.GLOBAL_KEY.endsWith("__"));
});

test("apply registers a sidebar row, a main panel, and the right-column members tab", () => {
	const exportsObject = loadBundle().materialize();
	const slots = createFakeSlots();
	exportsObject.apply({ slots });

	assert.deepEqual(slots.injected, ["sidebar.panellist", "main", "sidebar.right.pane.tab", "sidebar.right.pane.tab.title"]);
	// Three pieces plus the title: body and title go through separate slots, and a body
	// with no title renders as blank chrome.
	assert.equal(slots.registered.length, 4);

	const sidebar = slots.registered.find((entry) => entry.slotOptions.name === "sidebar.panellist");
	const main = slots.registered.find((entry) => entry.slotOptions.name === "main");
	assert.ok(sidebar !== undefined, "sidebar.panellist must be registered");
	assert.ok(main !== undefined, "main must be registered");
	assert.equal(sidebar.slotOptions.id, "a2a-groups");
	assert.equal(main.slotOptions.key, "a2a-groups");
	assert.equal(sidebar.slotOptions.id, main.slotOptions.key, "layout.selectPanel matches the row to the panel by this string");
	assert.equal(sidebar.slotOptions.order, 40);
	assert.equal(sidebar.slotOptions.label, "协作群");
	assert.equal(typeof sidebar.component, "function");
	assert.equal(typeof main.component, "function");

	// The members tab: one key, body and title registered under it.
	const membersBody = slots.registered.find((entry) => entry.slotOptions.name === "sidebar.right.pane.tab");
	const membersTitle = slots.registered.find((entry) => entry.slotOptions.name === "sidebar.right.pane.tab.title");
	assert.ok(membersBody !== undefined, "the members tab body must be registered");
	assert.ok(membersTitle !== undefined, "the members tab needs a title, or it renders as blank chrome");
	assert.equal(membersBody.slotOptions.key, exportsObject.MEMBERS_TAB_KEY);
	assert.equal(membersTitle.slotOptions.key, exportsObject.MEMBERS_TAB_KEY);
	assert.equal(typeof membersBody.component, "function");
	assert.equal(typeof membersTitle.component, "function");
});

test("apply survives a broken or absent slots service", () => {
	const exportsObject = loadBundle().materialize();
	for (const ctx of [undefined, null, {}, { slots: null }, { slots: {} }]) {
		assert.doesNotThrow(() => {
			exportsObject.apply(ctx);
		}, `apply(${JSON.stringify(ctx)}) must not throw`);
	}
	assert.doesNotThrow(() => {
		exportsObject.apply({ slots: createFakeSlots({ throwOnRegister: true }) });
	});
	assert.doesNotThrow(() => {
		exportsObject.apply({ slots: createFakeSlots({ throwOnInject: true }) });
	});
});

test("no data renders 还没有加入任何群 instead of throwing", () => {
	const { harness, exports: exportsObject } = bundleWith();
	assert.equal(harness.window[exportsObject.GLOBAL_KEY], undefined, "nothing injected yet");

	const text = textOf(exportsObject.GroupsPanel({}));
	assert.ok(text.includes("还没有加入任何群"), `empty state text missing, got: ${text}`);

	// The mount-time effect (subscription + polling) must also be safe.
	assert.ok(harness.effects.length > 0, "panel must subscribe on mount");
	for (const effect of harness.effects.slice()) {
		assert.doesNotThrow(() => {
			const cleanup = effect();
			if (typeof cleanup === "function") cleanup();
		});
	}
});

test("garbage data never throws and degrades to an empty snapshot", () => {
	const exportsObject = bundleWith().exports;
	const garbage = [
		null,
		"",
		"not json",
		42,
		true,
		{},
		{ groups: null },
		{ groups: "nope" },
		[null, 1, "x", false],
		{ groups: [{}] },
		{ groups: [{ name: null, members: 5, feed: "no" }] },
		{ groups: [{ members: [null, 1], feed: [null, {}], lastMessage: 7 }] },
	];
	for (const value of garbage) {
		const snapshot = exportsObject.readSnapshot(value);
		assert.equal(Array.isArray(snapshot.groups), true, `groups must always be an array for ${String(value)}`);
		assert.doesNotThrow(() => textOf(exportsObject.GroupsPanel({})), `render must not throw for ${String(value)}`);
	}
	for (const source of [undefined, null, "nope", 0, false]) {
		assert.equal(exportsObject.readSnapshot(source).groups.length, 0);
	}
});

test("an injected empty array still renders the empty state", () => {
	const { exports: exportsObject } = bundleWith([]);
	const text = textOf(exportsObject.GroupsPanel({}));
	assert.ok(text.includes("还没有加入任何群"), `expected empty state, got: ${text}`);
});

test("real data renders name, member count, unread badge and last message", () => {
	const now = Date.now();
	const { exports: exportsObject } = bundleWith({
		updatedAt: now,
		groups: [
			{
				id: "g-1",
				name: "内网部署协作群",
				memberCount: 3,
				unreadCount: 5,
				members: [
					{ id: "m-1", name: "我", self: true },
					{ id: "m-2", name: "阿强", role: "ops" },
					{ id: "m-3", name: "小美" },
				],
				feed: [
					{ id: "e-1", senderName: "阿强", text: "网关的证书我换好了", time: now - 120000, seq: 1 },
					{ id: "e-2", senderName: "小美", text: "收到，我这边回归", time: now - 60000, seq: 2 },
				],
			},
		],
	});
	const text = textOf(exportsObject.GroupsPanel({}));
	assert.ok(text.includes("内网部署协作群"), `group name missing: ${text}`);
	assert.ok(text.includes("3 人"), `member count missing: ${text}`);
	assert.ok(text.includes("5"), `unread badge missing: ${text}`);
	assert.ok(text.includes("收到，我这边回归"), `last message missing: ${text}`);
	assert.ok(text.includes("协作群"), `panel title missing: ${text}`);
});

test("expanding a group reveals members and the recent feed", () => {
	const now = Date.now();
	const { harness, exports: exportsObject } = bundleWith([
		{
			id: "g-2",
			name: "协议评审",
			members: [
				{ id: "m-1", name: "我", self: true },
				{ id: "m-2", name: "阿强" },
			],
			feed: [{ id: "e-9", senderName: "阿强", text: "A2A 1.0 定了", time: now }],
		},
	]);
	const group = exportsObject.readSnapshot(harness.window[exportsObject.GLOBAL_KEY]).groups[0];
	assert.equal(group.id, "g-2");

	const collapsed = textOf(exportsObject.GroupCard({ group, open: false, onToggle() {} }));
	const expanded = textOf(exportsObject.GroupCard({ group, open: true, onToggle() {} }));
	assert.ok(expanded.length > collapsed.length, "expanded card must reveal more content");
	assert.ok(expanded.includes("成员"), "member section missing when expanded");
	assert.ok(expanded.includes("我（我）"), `self marker missing: ${expanded}`);
	assert.ok(expanded.includes("A2A 1.0 定了"), `feed item missing: ${expanded}`);
	assert.ok(expanded.includes("只读"), "read-only notice missing when expanded");
});

test("sidebar row renders and tolerates missing props", () => {
	const { exports: exportsObject } = bundleWith({ groups: [{ id: "g", name: "x", unreadCount: 7 }] });
	const Icon = exportsObject.GroupsSidebarIcon;
	assert.doesNotThrow(() => textOf(Icon({})));
	assert.doesNotThrow(() => textOf(Icon({ size: 18, active: true })));
	assert.ok(textOf(Icon({ size: 16 })).includes("7"), "unread badge missing in the sidebar row");
});

test("a Host data source overrides the global and is preferred", () => {
	const { exports: exportsObject } = bundleWith([]);
	assert.ok(textOf(exportsObject.GroupsPanel({})).includes("还没有加入任何群"));

	exportsObject.setDataSource({
		read: () => ({ groups: [{ id: "g-3", name: "来自 remote 的群", unreadCount: 1 }] }),
	});
	assert.ok(textOf(exportsObject.GroupsPanel({})).includes("来自 remote 的群"), "data source ignored");

	exportsObject.setDataSource(null);
	assert.ok(textOf(exportsObject.GroupsPanel({})).includes("还没有加入任何群"), "clearing the source restores the empty state");

	// A bare reader function is accepted too.
	exportsObject.setDataSource(() => [{ id: "g-4", name: "函数式数据源" }]);
	assert.ok(textOf(exportsObject.GroupsPanel({})).includes("函数式数据源"), "function form ignored");
});

test("a throwing data source degrades instead of exploding", () => {
	const { harness, exports: exportsObject } = bundleWith();
	exportsObject.setDataSource({
		read() {
			throw new Error("remote is down");
		},
	});
	assert.doesNotThrow(() => textOf(exportsObject.GroupsPanel({})));
	assert.ok(harness.warnings.length > 0, "the failure must be reported, not swallowed silently");
});

test("subscribeGroups always returns a disposer, even for hostile sources", () => {
	const { exports: exportsObject } = bundleWith();
	const plain = exportsObject.subscribeGroups(() => undefined);
	assert.equal(typeof plain, "function");
	plain();

	exportsObject.setDataSource({
		read: () => ({ groups: [] }),
		subscribe() {
			throw new Error("subscribe broke");
		},
	});
	const hostile = exportsObject.subscribeGroups(() => undefined);
	assert.equal(typeof hostile, "function");
	assert.doesNotThrow(() => hostile());
});

test("snapshot normalization accepts seconds, ISO strings and aliases", () => {
	const exportsObject = bundleWith().exports;
	const iso = "2026-01-02T03:04:05.000Z";
	const snapshot = exportsObject.readSnapshot({
		groups: [
			{
				groupId: "g",
				title: "t",
				unread: "4",
				membersCount: "2",
				lastMessage: { from: "阿强", body: "hi", at: iso },
				messages: [{ text: "older", ts: 1767000000, sender: "x" }],
			},
		],
	});
	const group = snapshot.groups[0];
	assert.equal(group.id, "g");
	assert.equal(group.name, "t");
	assert.equal(group.unreadCount, 4);
	assert.equal(group.memberCount, 2);
	assert.equal(group.lastMessage.senderName, "阿强");
	assert.equal(group.lastMessage.text, "hi");
	assert.equal(group.lastTime, Date.parse(iso));
	assert.equal(snapshot.unreadTotal, 4);
	// Feed keeps only the feed array, normalized and sorted oldest -> newest.
	assert.equal(group.feed.length, 1);
	assert.equal(group.feed[0].text, "older");
	assert.equal(group.feed[0].time, 1767000000000);
});

test("feed is sorted ascending and capped", () => {
	const exportsObject = bundleWith().exports;
	const feed = [];
	for (let index = 0; index < 40; index += 1) {
		feed.push({ id: "e-" + String(index), text: "m" + String(index), time: 1700000000000 + index * 1000, seq: index });
	}
	// Shuffle deterministically: reverse then interleave.
	const shuffled = [];
	while (feed.length > 0) shuffled.push(feed.pop());
	const snapshot = exportsObject.readSnapshot({ groups: [{ id: "g", name: "n", feed: shuffled }] });
	const group = snapshot.groups[0];
	assert.equal(group.feed.length, 20, "feed is capped at the newest 20 entries");
	for (let index = 1; index < group.feed.length; index += 1) {
		assert.ok(group.feed[index - 1].time <= group.feed[index].time, "feed must be ascending by time");
	}
	assert.equal(group.feed[group.feed.length - 1].text, "m39", "newest entry stays last");
});

test("formatTime renders Chinese relative time and never throws", () => {
	const exportsObject = bundleWith().exports;
	const now = Date.now();
	assert.equal(exportsObject.formatTime(now), "刚刚");
	assert.equal(exportsObject.formatTime(now - 3 * 60 * 1000), "3 分钟前");
	assert.equal(exportsObject.formatTime(now - 5 * 60 * 60 * 1000), "5 小时前");
	for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined, null]) {
		assert.doesNotThrow(() => exportsObject.formatTime(value));
	}
});

test("normalizes the exact shape lib/groups.js snapshot() produces", () => {
	// Verbatim field names from lib/groups.js: publicGroup() + snapshot() + publicEntry()
	// + publicMember(). If branch C changes that shape, this test is the alarm.
	const harness = loadBundle();
	const exportsObject = harness.materialize();
	const now = 1767000000000;
	const raw = {
		groupId: "grp-8f21",
		name: "内网部署协作群",
		topic: "证书轮换与网关灰度",
		createdAt: now - 86400000,
		createdAtIso: new Date(now - 86400000).toISOString(),
		joinPolicy: "invite",
		owner: { memberId: "m-a", displayName: "阿强" },
		settings: { maxPostChars: 32000 },
		memberCount: 2,
		inviteCount: 1,
		lastSeq: 7,
		members: [
			{ memberId: "m-a", displayName: "阿强", role: "owner", joinedAt: now - 86400000, online: true, endpoint: "http://x/a2a" },
			{ memberId: "m-b", displayName: "小美", role: "member", joinedAt: now - 3600000, online: false },
		],
		feedTail: [
			{ seq: 6, at: now - 120000, msgId: "uuid-6", kind: "message", from: { memberId: "m-a", displayName: "阿强" }, text: "证书我换好了" },
			{ seq: 7, at: now - 60000, msgId: "uuid-7", kind: "message", from: { memberId: "m-b", displayName: "小美" }, text: "收到，我这边回归" },
		],
		lastPost: { seq: 7, at: now - 60000, msgId: "uuid-7", kind: "message", from: { memberId: "m-b", displayName: "小美" }, text: "收到，我这边回归" },
		lastPostAt: now - 60000,
		lastPostAtIso: new Date(now - 60000).toISOString(),
		onlineCount: 1,
	};

	const snapshot = exportsObject.readSnapshot([raw]);
	assert.equal(snapshot.groups.length, 1);
	const group = snapshot.groups[0];
	assert.equal(group.id, "grp-8f21", "groupId must be picked up");
	assert.equal(group.name, "内网部署协作群");
	assert.equal(group.topic, "证书轮换与网关灰度");
	assert.equal(group.memberCount, 2, "memberCount is authoritative, not members.length");
	assert.equal(group.members.length, 2);
	assert.equal(group.members[0].id, "m-a", "memberId must be picked up");
	assert.equal(group.members[0].name, "阿强", "displayName must be picked up");
	assert.equal(group.members[0].role, "owner");
	assert.equal(group.members[0].online, true);
	assert.equal(group.feed.length, 2, "feedTail must be picked up");
	assert.equal(group.feed[1].id, "uuid-7", "msgId must be picked up");
	assert.equal(group.feed[1].senderName, "小美", "from.displayName must be picked up");
	assert.equal(group.feed[1].time, now - 60000, "at must be picked up as epoch ms");
	assert.equal(group.lastMessage.text, "收到，我这边回归", "lastPost must be picked up");
	assert.equal(group.lastTime, now - 60000);

	// And it renders once injected into the Host slot.
	harness.setGlobal([raw]);
	const text = textOf(exportsObject.GroupsPanel({}));
	assert.ok(text.includes("内网部署协作群"), text);
	assert.ok(text.includes("收到，我这边回归"), text);
});

test("a counts-only summary (no member credential) renders without a feed", () => {
	// lib/groups.js snapshot() without `input.member` returns feedTail: [] on purpose.
	const exportsObject = bundleWith().exports;
	const snapshot = exportsObject.readSnapshot([{ groupId: "grp-x", name: "只有元数据的群", memberCount: 4, lastPostAt: 1767000000000 }]);
	const group = snapshot.groups[0];
	assert.equal(group.feed.length, 0);
	assert.equal(group.lastMessage, undefined);
	assert.equal(group.lastTime, 0, "lastPostAt alone must not invent a message");
	assert.equal(group.memberCount, 4);
	assert.doesNotThrow(() => textOf(exportsObject.GroupsPanel({})));
});

test("elements carry inline styles only", () => {
	const { exports: exportsObject } = bundleWith({ groups: [{ id: "g", name: "n", feed: [{ text: "hi", time: Date.now() }] }] });
	const Text = textOf(exportsObject.GroupsPanel({}));
	assert.ok(Text.length > 0);
	// No element may rely on a class name: that would imply a CSS file.
	const collect = (node, sink = []) => {
		if (node === null || node === undefined || node === false) return sink;
		if (Array.isArray(node)) {
			for (const child of node) collect(child, sink);
			return sink;
		}
		if (typeof node === "object") {
			sink.push(node);
			if (typeof node.type === "function") return collect(node.type(node.props), sink);
			for (const child of node.children) collect(child, sink);
		}
		return sink;
	};
	for (const element of collect(exportsObject.GroupsPanel({}))) {
		assert.equal(element.props.className, undefined, "no className: styles must be inline");
		if (element.props.style !== undefined) assert.equal(typeof element.props.style, "object");
	}
});

test("component render never throws for an undefined props object", () => {
	const exportsObject = bundleWith().exports;
	for (const name of ["GroupsPanel", "GroupsSidebarIcon", "EmptyState"]) {
		assert.doesNotThrow(() => exportsObject[name](undefined));
	}
});
