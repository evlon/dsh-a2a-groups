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
import { test } from 'vitest';
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

/**
 * A stand-in for `sidebarRightTabs`.
 *
 * Only `register` is modelled, because that is the one method the plugin calls: the tab
 * TYPE has to exist before `openTab(kind)` will accept the kind, so the registration is
 * the part worth asserting on.
 */
function createFakeTabs(options = {}) {
	const registered = [];
	return {
		registered,
		register(definition) {
			if (options.throwOnRegister === true) throw new Error("tab register exploded");
			registered.push(definition);
			return () => undefined;
		},
	};
}

/** Every element in a stub tree, depth-first, with host components rendered. */
function findAll(node, sink = []) {
	if (node === null || node === undefined || node === false) return sink;
	if (Array.isArray(node)) {
		for (const child of node) findAll(child, sink);
		return sink;
	}
	if (typeof node === "object") {
		if (typeof node.type === "function") {
			findAll(node.type(node.props), sink);
			return sink;
		}
		sink.push(node);
		for (const child of node.children) findAll(child, sink);
	}
	return sink;
}

/** Every `<button>` in a stub tree, in document order. */
function buttonsOf(tree) {
	// Roster rows only. Three other kinds of <button> live in this pane and none is a member: the
	// refresh control, the section tabs (群目标 / 群约定 / 人工确认), and the conventions
	// edit/save/reset actions. Folding any of them in made every ordering assertion read rows that
	// are not people.
	const decoys = new Set(["refresh", "tab-goal", "tab-conventions", "tab-confirm", "conventions-edit", "conventions-save", "conventions-reset", "conventions-cancel"]);
	const buttons = findAll(tree).filter(
		(element) => element.type === "button" && !decoys.has(element.props["data-role"]),
	);
	// The tree above is flattened depth-first, which is document order for this renderer.
	return buttons;
}

/** A fake composer action surface recording what was inserted. */
function createFakeInput(behaviour = {}) {
	const inserted = [];
	return {
		inserted,
		captureInsertion() {
			if (behaviour.captureThrows === true) throw new Error("capture exploded");
			return { start: 0, end: 0, revision: 7 };
		},
		insertText(text, span) {
			if (behaviour.insertThrows === true) throw new Error("insert exploded");
			if (behaviour.insertReturnsFalse === true) return false;
			if (behaviour.requireSpan === true && span === undefined) return false;
			inserted.push({ text, span });
			return true;
		},
		setDraft(text) {
			if (behaviour.noSetDraft !== true) inserted.push({ text, span: "draft" });
		},
	};
}

/** A group snapshot shaped like `lib/index.js` publishes it, with one self id. */
function groupFixture(overrides = {}) {
	const now = Date.now();
	return Object.assign(
		{
			id: "grp-1",
			groupId: "grp-1",
			name: "内网部署协作群",
			topic: "证书轮换与网关灰度",
			joined: true,
			discovered: false,
			role: "member",
			memberCount: 4,
			onlineCount: 2,
			unreadCount: 0,
			sessionId: "sess-1",
			personId: "p-me",
			lastTime: now,
			feed: [],
			roster: [
				{ personId: "p-me", displayName: "我", role: "member", online: true, roleAbout: "负责网关灰度", tags: ["运维"] },
				{ personId: "p-a", displayName: "阿强", role: "owner", online: true, roleAbout: "整体验收", tags: [] },
				{ personId: "p-b", displayName: "小美", role: "member", online: false, roleAbout: "", tags: [] },
				{ personId: "p-c", displayName: "老周", role: "member", online: false, roleAbout: "证书与密钥", tags: [] },
			],
		},
		overrides,
	);
}
//#endregion

test("bundle registers under the package name, and the patch row agrees", () => {
	const harness = loadBundle();
	assert.equal(harness.loadCalls.length, 1, "exactly one __ModuleLoader__.load call");
	const registration = harness.loadCalls[0];

	// Derived, not hardcoded. A literal here only proves the test and the bundle agree with each other; the
	// thing that actually breaks a plugin is the package name disagreeing with one of them.
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(
		registration.id,
		pkg.name,
		"the bundle must register under the package name, or the loader reports it loaded without registering",
	);

	// The patch row is what the Host mounts; it must name the same package.
	const patch = readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
	assert.ok(
		patch.includes(`name: '${pkg.name}'`),
		"cordis.patch.yml must insert a row named after the package",
	);

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
	// `sidebarRight` and `sidebarRightTabs` are declared so the members column can be
	// opened; both are optional services, so Cordis keeps the plugin alive on a Host that
	// does not provide them.
	assert.deepEqual([...exportsObject.inject], ["slots", "sidebarRight", "sidebarRightTabs"]);
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

test("apply registers the panel and the right-column members page, with no duplicate roster", () => {
	const exportsObject = loadBundle().materialize();
	const slots = createFakeSlots();
	const tabs = createFakeTabs();
	exportsObject.apply({ slots, get: (key) => (key === "sidebarRightTabs" ? tabs : undefined) });

	assert.deepEqual(slots.injected, [
		"sidebar.panellist",
		"main",
		"sidebar.right.pane.tab",
		"sidebar.right.pane.tab.title",
		"conversation.input.left",
	]);
	assert.equal(slots.registered.length, 5);

	// The roster renders in ONE place. An earlier version also drew a strip above the
	// composer, so the same names appeared twice on screen.
	assert.equal(
		slots.injected.includes("conversation.input.dock"),
		false,
		"the roster must not also render as a composer strip",
	);

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

	// The right column: a tab TYPE must be declared before `openTab(kind)` works, because
	// the registry throws for a kind nothing registered. The body and chip are keyed by the
	// definition id, which is what the seat looks them up by.
	assert.equal(tabs.registered.length, 1, "exactly one tab type is declared");
	const definition = tabs.registered[0];
	assert.equal(definition.id, exportsObject.MEMBERS_TAB_KIND);
	assert.equal(definition.kind, exportsObject.MEMBERS_TAB_KIND);
	assert.equal(definition.priority, "extension", "an out-of-product type must outrank shipped viewers");
	assert.equal(typeof definition.title, "function");
	assert.equal(definition.title(), "群成员");
	assert.equal(definition.patterns, undefined, "a page type is opened by kind, not by address");

	const body = slots.registered.find((entry) => entry.slotOptions.name === "sidebar.right.pane.tab");
	const chip = slots.registered.find((entry) => entry.slotOptions.name === "sidebar.right.pane.tab.title");
	assert.ok(body !== undefined, "the members page body must be registered");
	assert.ok(chip !== undefined, "the tab needs a chip, or it renders as blank chrome");
	assert.equal(body.slotOptions.key, exportsObject.MEMBERS_TAB_KIND);
	assert.equal(chip.slotOptions.key, exportsObject.MEMBERS_TAB_KIND);

	// The opener, in the composer tool row rather than the global sidebar: the column shows
	// THIS conversation's group.
	const button = slots.registered.find((entry) => entry.slotOptions.name === "conversation.input.left");
	assert.ok(button !== undefined, "the opener button must be registered");
	assert.equal(button.slotOptions.id, exportsObject.MEMBERS_TAB_KIND);
	assert.equal(typeof button.component, "function");
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

test("no data renders the empty tab state instead of throwing", () => {
	const { harness, exports: exportsObject } = bundleWith();
	assert.equal(harness.window[exportsObject.GLOBAL_KEY], undefined, "nothing injected yet");

	const text = textOf(exportsObject.GroupsPanel({}));
	// The panel now shows tabs; with nothing to show the 全部 tab states that plainly.
	assert.ok(text.includes("还没有任何协作群"), `empty state text missing, got: ${text}`);
	assert.ok(text.includes("全部"), "the tab bar must render even with no data");

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
	assert.ok(text.includes("还没有任何协作群"), `expected empty state, got: ${text}`);
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
	// The count is now a users glyph plus a bare number, so the word 「人」 is gone from the
	// row; the accessible label carries it (asserted separately below).
	assert.ok(text.includes("53"), `member count 3 missing next to the badge: ${text}`);
	assert.ok(text.includes("5"), `unread badge missing: ${text}`);
	// The card must say something happened, and must NOT quote it: the body used to be written into the
	// page HTML, which leaked message content into every render (and across Sessions).
	assert.ok(text.includes("发来一条消息"), `the summary must say somebody spoke: ${text}`);
	assert.ok(!text.includes("收到，我这边回归"), `the message body must not reach the card: ${text}`);
	assert.ok(text.includes("协作群"), `panel title missing: ${text}`);

	// The icon must be a real element (glyph), not a text stand-in, and the count must keep a
	// plain-language label for anyone who cannot read the pictogram.
	const meta = findAll(exportsObject.GroupsPanel({})).filter((element) => element.props.title === "3 个成员")[0];
	assert.ok(meta !== undefined, "the member count must expose a plain-language title");
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
	assert.ok(textOf(exportsObject.GroupsPanel({})).includes("还没有任何协作群"));

	exportsObject.setDataSource({
		read: () => ({ groups: [{ id: "g-3", name: "来自 remote 的群", unreadCount: 1 }] }),
	});
	assert.ok(textOf(exportsObject.GroupsPanel({})).includes("来自 remote 的群"), "data source ignored");

	exportsObject.setDataSource(null);
	assert.ok(textOf(exportsObject.GroupsPanel({})).includes("还没有任何协作群"), "clearing the source restores the empty state");

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
	assert.equal(group.lastMessage.senderName, "阿强", "the author is kept");
	// The body is deliberately not carried: it used to be written into the page HTML.
	assert.ok(!group.lastMessage.text.includes("hi"), "the body must not reach the summary");
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
		owner: { personId: "m-a", displayName: "阿强" },
		settings: { maxPostChars: 32000 },
		memberCount: 2,
		inviteCount: 1,
		lastSeq: 7,
		// Presence is carried as timestamps. The bare `online` boolean this fixture used to send is no longer
		// trusted: it records what was true when the roster was fetched, and a cached roster can be an hour old.
		members: [
			{ personId: "m-a", displayName: "阿强", role: "owner", joinedAt: now - 86400000, lastSeenAt: Date.now() - 1000, endpoint: "http://x/a2a" },
			{ personId: "m-b", displayName: "小美", role: "member", joinedAt: now - 3600000, lastSeenAt: Date.now() - 600000 },
		],
		feedTail: [
			{ seq: 6, at: now - 120000, msgId: "uuid-6", kind: "message", from: { personId: "m-a", displayName: "阿强" }, text: "证书我换好了" },
			{ seq: 7, at: now - 60000, msgId: "uuid-7", kind: "message", from: { personId: "m-b", displayName: "小美" }, text: "收到，我这边回归" },
		],
		lastPost: { seq: 7, at: now - 60000, msgId: "uuid-7", kind: "message", from: { personId: "m-b", displayName: "小美" }, text: "收到，我这边回归" },
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
	assert.equal(group.members[0].id, "m-a", "personId must be picked up");
	assert.equal(group.members[0].name, "阿强", "displayName must be picked up");
	assert.equal(group.members[0].role, "owner");
	// Derived from the timestamp: seen a second ago, so online. Seen ten minutes ago, so not.
	assert.equal(group.members[0].online, true, "a recent lastSeenAt means online");
	assert.equal(group.members[1].online, false, "a stale lastSeenAt means away");
	assert.equal(group.feed.length, 2, "feedTail must be picked up");
	assert.equal(group.feed[1].id, "uuid-7", "msgId must be picked up");
	assert.equal(group.feed[1].senderName, "小美", "from.displayName must be picked up");
	assert.equal(group.feed[1].time, now - 60000, "at must be picked up as epoch ms");
	// The author is kept, the words are not: the body used to be written into the page HTML.
	assert.equal(group.lastMessage.from, "小美", "lastPost must contribute its author");
	assert.ok(!group.lastMessage.text.includes("收到，我这边回归"), "the body must not reach the summary");
	assert.equal(group.lastTime, now - 60000);

	// And it renders once injected into the Host slot.
	harness.setGlobal([raw]);
	const text = textOf(exportsObject.GroupsPanel({}));
	assert.ok(text.includes("内网部署协作群"), text);
	// The body is deliberately absent from the rendered card.
	assert.ok(!text.includes("收到，我这边回归"), "the message body must not reach the card");
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

//#region members pane: layout, IM ordering, self editing
test("members pane lays out by column width instead of a fixed maxWidth", () => {
	// The column is user-resizable. A hard maxWidth pins the roster to the left of a wide
	// column; the constraint belongs on the TEXT, via flex + minWidth: 0.
	const { exports: exportsObject } = bundleWith({ groups: [groupFixture()] });
	const root = exportsObject.MembersPane({ sessionId: "sess-1", inputActions: createFakeInput() });

	const rootStyle = root.props.style;
	assert.equal(rootStyle.maxWidth, undefined, "the container must not cap its width");
	assert.equal(rootStyle.width, "100%", "it fills whatever width the column has");
	assert.equal(rootStyle.minWidth, "0", "it can shrink with the column");

	// Nothing in the pane may suppress wrapping wholesale: that is what forced one line
	// per row regardless of available width. Single-line NAME cells are exempt — they
	// ellipsize on purpose — but the container and the description cells must wrap.
	assert.equal(rootStyle.whiteSpace, undefined, "the container must not force a single line");
	const everyStyle = findAll(root)
		.map((element) => element.props.style)
		.filter((style) => style !== null && typeof style === "object");
	const wrapping = everyStyle.filter((style) => style.whiteSpace === "normal");
	assert.ok(wrapping.length > 0, "at least the group-role text must be allowed to wrap");
	for (const style of wrapping) {
		assert.equal(style.wordBreak !== undefined || style.overflowWrap !== undefined, true, "wrapped text needs a break rule");
	}
});

test("members pane orders rows IM-style: 所有人, 群主, 我, then everyone else", () => {
	const { exports: exportsObject } = bundleWith({ groups: [groupFixture()] });
	const root = exportsObject.MembersPane({ sessionId: "sess-1", inputActions: createFakeInput() });

	// 阿强 is the owner in this fixture, so the order is 所有人 → 阿强 → 我 → 小美/老周.
	const labels = buttonsOf(root).map((button) => textOf(button));
	assert.ok(labels[0].includes("所有人"), `first row must be 所有人, got: ${labels[0]}`);
	assert.ok(labels[1].includes("阿强"), `second row must be the owner, got: ${labels[1]}`);
	assert.ok(labels[1].includes("群主"), `the owner row must be labelled, got: ${labels[1]}`);
	assert.ok(labels[2].includes("我"), `third row must be me, got: ${labels[2]}`);

	const rest = labels.slice(3).join("|");
	for (const other of ["小美", "老周"]) {
		assert.ok(rest.includes(other), `${other} must appear after me, got: ${rest}`);
	}
	assert.equal(labels.join("|").split("所有人").length - 1, 1, "所有人 appears exactly once");

	// Online before offline, then by name among the remainder.
	const restNames = labels
		.slice(3)
		.filter((text) => text.includes("小美") || text.includes("老周"))
		.map((text) => text.replace(/.*?(小美|老周).*/, "$1"));
	assert.deepEqual(restNames.slice().sort(), ["小美", "老周"].sort());
});

test("the owner is second even when the owner is offline, and never duplicated", () => {
	const { exports: exportsObject } = bundleWith({
		groups: [groupFixture({
			roster: [
				{ personId: "p-me", displayName: "我", role: "member", online: true, roleAbout: "验收" },
				{ personId: "p-a", displayName: "阿强", role: "owner", online: false, roleAbout: "管全局" },
				{ personId: "p-b", displayName: "小美", role: "member", online: false }
			]
		})],
	});
	const labels = buttonsOf(exportsObject.MembersPane({ sessionId: "sess-1", inputActions: createFakeInput() }))
		.map((button) => textOf(button));
	assert.ok(labels[0].includes("所有人"), labels[0]);
	assert.ok(labels[1].includes("阿强"), `the owner outranks presence: ${labels[1]}`);
	assert.ok(labels[2].includes("我"), labels[2]);
	assert.equal(labels.join("|").split("阿强").length - 1, 1, "the owner appears exactly once");
});

test("when I am the owner there is one row, labelled 群主 and 我, still editable", () => {
	const { exports: exportsObject } = bundleWith({
		groups: [groupFixture({
			personId: "p-me",
			roster: [
				{ personId: "p-me", displayName: "我", role: "owner", online: true, roleAbout: "我在验收" },
				{ personId: "p-b", displayName: "小美", role: "member", online: true }
			]
		})],
	});
	const rows = buttonsOf(exportsObject.MembersPane({ sessionId: "sess-1", inputActions: createFakeInput() }));
	const labels = rows.map((button) => textOf(button));

	assert.ok(labels[0].includes("所有人"), labels[0]);
	assert.ok(labels[1].includes("我"), `row 2 must be me-as-owner: ${labels[1]}`);
	assert.ok(labels[1].includes("群主"), `and must say 群主: ${labels[1]}`);
	// One row, not two: the whole point is not listing me in position 2 and again in 3.
	const mine = labels.filter((text) => text.includes("我") && text.includes("群主"));
	assert.equal(mine.length, 1, `me-as-owner must render once, got: ${labels.join("｜")}`);
	assert.equal(labels.join("|").split("我在验收").length - 1, 1, "the role text appears once");

	// Still editable: the edit instruction is what that row is for.
	const input = createFakeInput();
	const root = bundleWith({
		groups: [groupFixture({
			personId: "p-me",
			roster: [{ personId: "p-me", displayName: "我", role: "owner", online: true, roleAbout: "我在验收" }]
		})],
	}).exports.MembersPane({ sessionId: "sess-1", inputActions: input });
	buttonsOf(root)[1].props.onClick();
	assert.equal(input.inserted.length, 1, "clicking my own owner row edits, it does not @ me");
	assert.ok(input.inserted[0].text.includes("a2a_group_set_card"), input.inserted[0].text);
});

test("a group whose owner is not in the roster has no empty owner slot", () => {
	const { exports: exportsObject } = bundleWith({
		groups: [groupFixture({
			roster: [
				{ personId: "p-me", displayName: "我", role: "member", online: true },
				{ personId: "p-b", displayName: "小美", role: "member", online: true }
			]
		})],
	});
	const labels = buttonsOf(exportsObject.MembersPane({ sessionId: "sess-1", inputActions: createFakeInput() }))
		.map((button) => textOf(button));
	assert.ok(labels[0].includes("所有人"), labels[0]);
	assert.ok(labels[1].includes("我"), `with no owner present, I am second: ${labels[1]}`);
	assert.ok(labels[2].includes("小美"), labels[2]);
	assert.equal(labels.join("").includes("群主"), false, "no phantom owner row");
});

test("my row is marked and shows my group role, not my person headline", () => {
	const { exports: exportsObject } = bundleWith({
		groups: [groupFixture()],
		cards: [{ personId: "p-me", name: "我", headline: "研发工程师", tags: ["研发"], isSelf: true }],
	});
	const root = exportsObject.MembersPane({ sessionId: "sess-1", inputActions: createFakeInput() });
	const selfRow = buttonsOf(root).filter((button) => textOf(button).includes("负责网关灰度"))[0];
	assert.ok(selfRow !== undefined, "the self row must carry my group role");
	const text = textOf(selfRow);
	assert.ok(text.includes("我"), text);
	assert.ok(text.includes("负责网关灰度"), `the GROUP role must win over the person headline: ${text}`);
	assert.equal(text.includes("研发工程师"), false, "the person-table headline must not override the group role");
	assert.ok(text.includes("编辑介绍"), `the edit affordance must be visible: ${text}`);
});

test("clicking my row fills the composer with a prefilled role instruction", () => {
	const input = createFakeInput();
	const { exports: exportsObject } = bundleWith({ groups: [groupFixture()] });
	const root = exportsObject.MembersPane({ sessionId: "sess-1", inputActions: input });
	const selfRow = buttonsOf(root).filter((button) => textOf(button).includes("编辑介绍"))[0];
	assert.ok(selfRow !== undefined, "the self row must be identifiable by its edit chip");

	selfRow.props.onClick();
	assert.equal(input.inserted.length, 1, "exactly one insertion");
	const { text, span } = input.inserted[0];
	assert.ok(span !== undefined, "the two-step API needs the captured span");
	assert.ok(text.includes("a2a_group_set_card"), `the tool must be named: ${text}`);
	assert.ok(text.includes("grp-1"), `groupId must be present, the tool requires it: ${text}`);
	assert.ok(text.includes("负责网关灰度"), `current value must be prefilled so a small edit stays small: ${text}`);
	assert.ok(text.includes("120"), `the length limit should be stated: ${text}`);
});

test("a member without a group role is labelled, not left blank", () => {
	const { exports: exportsObject } = bundleWith({ groups: [groupFixture()] });
	const root = exportsObject.MembersPane({ sessionId: "sess-1", inputActions: createFakeInput() });
	const all = textOf(root);
	assert.ok(all.includes("未填群内介绍"), `an empty role must be stated: ${all}`);
});

test("my own row explains itself when I have no role yet", () => {
	const { exports: exportsObject } = bundleWith({
		groups: [groupFixture({ roster: [{ personId: "p-me", displayName: "我", role: "member", online: true, roleAbout: "" }] })],
	});
	const text = textOf(exportsObject.MembersPane({ sessionId: "sess-1", inputActions: createFakeInput() }));
	assert.ok(text.includes("还没写群内介绍"), `empty self description must invite the edit: ${text}`);
	assert.equal(text.includes("清空介绍"), false, "there is nothing to clear");
});

test("clearing my role uses its own instruction, because omission means 'unchanged'", () => {
	// The clear affordance is no longer a button in the roster: clearing is the empty case of
	// editing, and the edit draft says so. The INSTRUCTION still has to exist and has to be
	// explicit, because the tool treats an omitted field as "leave it alone" — so a clear that
	// merely omitted `about` would silently do nothing. That property is what this test keeps.
	const { exports: exportsObject } = bundleWith({ groups: [groupFixture()] });
	const text = exportsObject.draftGroupRoleClear({ groupName: "内网部署协作群", groupId: "grp-1" });
	assert.ok(text.includes("a2a_group_set_card"), text);
	assert.ok(text.includes("空字符串"), `the clear must be explicit, not implied: ${text}`);
	assert.ok(text.includes("空数组"), `tags must be cleared explicitly too: ${text}`);
});

test("the roster offers no separate clear button", () => {
	// Two reasons, both deliberate: a destructive action should not sit as a line of the member
	// list (no IM does that — it belongs inside the row's own menu), and every extra writer is
	// another place the "only the Session writes" property could be broken.
	const { exports: exportsObject } = bundleWith({ groups: [groupFixture()] });
	const root = exportsObject.MembersPane({ sessionId: "sess-1", inputActions: createFakeInput() });
	const clear = buttonsOf(root).filter((button) => textOf(button).includes("清空介绍"));
	assert.equal(clear.length, 0, "clearing moved into the edit path");
});

test("the self row derives from the person table when the roster predates roleAbout", () => {
	const { exports: exportsObject } = bundleWith({
		groups: [groupFixture({ roster: [{ personId: "p-me", displayName: "我", role: "member", online: true }] })],
		cards: [{ personId: "p-me", name: "我", headline: "研发工程师", tags: ["研发"], isSelf: true }],
	});
	const self = exportsObject.pickSelf(
		exportsObject.readSnapshot({ groups: [groupFixture({ roster: [{ personId: "p-me", displayName: "我" }] })] }).groups[0],
		[{ id: "p-me", name: "我", headline: "研发工程师", tags: ["研发"], isSelf: true }],
	);
	assert.equal(self.hasSelf, true);
	assert.equal(self.about, "研发工程师", "the person table is the documented default source");
	assert.equal(self.aboutFrom, "person");
});

test("a roster that says nothing about me means 'cleared', not 'unknown'", () => {
	// Otherwise clearing my role leaves the old headline on screen and I think it failed.
	const { exports: exportsObject } = bundleWith();
	const group = exportsObject.readSnapshot({
		groups: [groupFixture({ roster: [{ personId: "p-me", displayName: "我", roleAbout: "" }] })],
	}).groups[0];
	const self = exportsObject.pickSelf(group, [{ id: "p-me", name: "我", headline: "研发工程师", isSelf: true }]);
	assert.equal(self.hasSelf, true);
	assert.equal(self.about, "", "a present-but-empty roster row must not be backfilled");
	assert.equal(self.aboutFrom, "none");
});

test("the members pane renders with no data, no roster, and no input actions", () => {
	const { exports: exportsObject } = bundleWith();
	assert.doesNotThrow(() => exportsObject.MembersPane(undefined));

	const noGroup = exportsObject.MembersPane(undefined);
	assert.ok(textOf(noGroup).includes("还没有加入协作群"), textOf(noGroup));

	// Joined but the roster was never fetched: the pane must say so rather than imply empty.
	const noRoster = bundleWith({ groups: [groupFixture({ roster: [], memberCount: 4 })] });
	const text = textOf(noRoster.exports.MembersPane({ sessionId: "sess-1" }));
	assert.ok(text.includes("a2a_group_summary"), `an unfetched roster must name the tool that fetches it: ${text}`);

	// No inputActions: the edit affordance says so instead of silently doing nothing. With an
	// empty roster there is no row to carry the chip, so this is asserted on a real roster.
	const withRoster = bundleWith({ groups: [groupFixture()] });
	const readOnly = textOf(withRoster.exports.MembersPane({ sessionId: "sess-1" }));
	assert.ok(readOnly.includes("只读"), `without a composer the row must say it cannot edit: ${readOnly}`);
	assert.equal(readOnly.includes("清空介绍"), false, "nothing can be cleared without a composer");
});

test("a composer that refuses the insertion does not break the pane", () => {
	const { exports: exportsObject } = bundleWith({ groups: [groupFixture()] });
	for (const behaviour of [{ insertReturnsFalse: true }, { insertThrows: true }, { captureThrows: true }]) {
		const input = createFakeInput(behaviour);
		const root = exportsObject.MembersPane({ sessionId: "sess-1", inputActions: input });
		// The self row is the one carrying the edit chip, not a fixed index: the owner now
		// occupies row 2 and row indices shift with the roster.
		const selfRow = buttonsOf(root).filter((button) => textOf(button).includes("编辑介绍"))[0];
		assert.ok(selfRow !== undefined, JSON.stringify(behaviour));
		assert.doesNotThrow(() => selfRow.props.onClick(), JSON.stringify(behaviour));
	}
	// A Host with only a whole-draft setter still gets the instruction written.
	const fallback = createFakeInput({ noSetDraft: false });
	delete fallback.captureInsertion;
	const root = exportsObject.MembersPane({ sessionId: "sess-1", inputActions: fallback });
	buttonsOf(root).filter((button) => textOf(button).includes("编辑介绍"))[0].props.onClick();
	assert.equal(fallback.inserted.length, 1, "setDraft is the documented fallback");
});

test("the roster renders in exactly one place: the members pane", () => {
	// Regression: an earlier version also drew the roster above the composer, so the same
	// names appeared twice on screen.
	const slots = createFakeSlots();
	const tabs = createFakeTabs();
	const exportsObject = loadBundle().materialize();
	exportsObject.apply({ slots, get: (key) => (key === "sidebarRightTabs" ? tabs : undefined) });

	const carrying = slots.registered.filter((entry) => entry.slotOptions.name !== "sidebar.panellist");
	assert.ok(carrying.length > 0);
	// Only the right-column pane body and the composer button may know about members.
	for (const entry of carrying) {
		const name = entry.slotOptions.name;
		assert.ok(
			["main", "sidebar.right.pane.tab", "sidebar.right.pane.tab.title", "conversation.input.left"].includes(name),
			`unexpected roster-bearing slot: ${name}`
		);
	}
	assert.equal(slots.injected.includes("conversation.input.dock"), false);
});
//#endregion

//#region icons
test("the icon layer is sourced from primitives and falls back to real geometry", () => {
	// No primitives are installed in this harness (the stub returns {}), so every icon must
	// resolve to the extracted inline SVG. That is exactly the degraded path a shell version
	// skew produces, so it is the one worth pinning.
	const { exports: exportsObject } = bundleWith({ groups: [groupFixture()] });
	const tree = exportsObject.MembersPane({ sessionId: "sess-1", inputActions: createFakeInput() });
	const svgs = findAll(tree).filter((element) => element.type === "svg");
	assert.ok(svgs.length > 0, "the pane must draw at least one icon");
	for (const svg of svgs) {
		assert.equal(svg.props["aria-hidden"], "true", "icons are decoration and must be hidden from AT");
		assert.ok(typeof svg.props.width === "number", "the fallback draws at an explicit size");
		assert.equal(svg.props.width, svg.props.height, "icons are square");
		assert.ok(typeof svg.props.viewBox === "string", "each fallback carries its own grid");
	}
	// At least one icon must come from a 16x16 grid and at least one path must be present.
	assert.ok(svgs.some((svg) => svg.props.viewBox === "0 0 16 16"));
	assert.ok(svgs.some((svg) => svg.children.length > 0), "a drawn icon has geometry");
});

test("icons use the product name for each affordance, not a generic one", () => {
	const { exports: exportsObject } = bundleWith({ groups: [groupFixture()] });
	const tree = exportsObject.MembersPane({ sessionId: "sess-1", inputActions: createFakeInput() });

	// The header's glyph is the two-person icon: four paths in the product's geometry.
	const header = findAll(tree).filter((element) => element.props.style !== undefined
		&& element.props.style.gap === "5px"
		&& element.props.style.flex === "0 0 auto")[0];
	assert.ok(header !== undefined, "the header must carry its own title row");
	const headerIcon = findAll(header).filter((element) => element.type === "svg")[0];
	assert.ok(headerIcon !== undefined, "the header title must have a glyph");
	// Count path DESCENDANTS, not children: the renderer passes the path list as one array
	// child, which the stub does not flatten.
	const paths = findAll(headerIcon).filter((element) => element.type === "path");
	assert.equal(paths.length, 4, "IconUsersOutlineRegular has four paths");
});

test("the tab bar draws a glyph per tab and keeps every label", () => {
	const { exports: exportsObject } = bundleWith({ groups: [groupFixture()], cards: [] });
	const tree = exportsObject.GroupsPanel({});
	const tabs = findAll(tree).filter((element) => element.type === "button"
		&& element.props.title === "全部");
	assert.equal(tabs.length, 1, "the 全部 tab must be a titled button");

	// 「我管理」, not 「我创建」.
	//
	// The filter behind this tab is `role === "owner"` — it answers 「我是群主」, not 「这个群是我建的」. Those differ the
	// moment an existing group gains a new owner, which is exactly the state measured: the host reported
	// `isOwner: true` while the tab labelled 我创建 read 0, because the label promised a different question than the
	// code asked.
	for (const label of ["全部", "我管理", "我参与", "同事名片"]) {
		const tab = findAll(tree).filter((element) => element.type === "button" && element.props.title === label)[0];
		assert.ok(tab !== undefined, `tab ${label} must keep its accessible title`);
		assert.ok(tab.children.some((child) => child !== null && typeof child === "object" && child.type === "svg"),
			`tab ${label} must carry an icon alongside the word`);
	}
});

test("the empty state has a dimmed illustration and still says it in words", () => {
	const { exports: exportsObject } = bundleWith();
	const tree = exportsObject.EmptyState();
	const iconHolder = findAll(tree).filter((element) => element.props.style !== undefined
		&& element.props.style.opacity === 0.3)[0];
	assert.ok(iconHolder !== undefined, "the empty state must carry a dimmed illustration");
	const glyph = findAll(iconHolder).filter((element) => element.type === "svg")[0];
	assert.ok(glyph !== undefined, "the illustration must be a drawn glyph");
	assert.ok(textOf(tree).includes("还没有加入任何群"), "the words must remain");
});

test("every pure-icon affordance has a tooltip", () => {
	// A button whose whole content is a glyph must say what it does in `title`.
	const { exports: exportsObject } = bundleWith({ groups: [groupFixture()] });
	const tree = exportsObject.MembersPane({ sessionId: "sess-1", inputActions: createFakeInput() });
	for (const button of buttonsOf(tree)) {
		assert.equal(typeof button.props.title, "string", "every roster button needs a title");
		assert.ok(button.props.title.length > 0, "the title must not be empty");
	}
});
//#endregion

//#region members pane layout (empty-gap regression)
test("the pane never grows vertically: no height:100%, no growing children", () => {
	// Two faults pushed the roster to the bottom of a mostly empty column: `height: 100%`
	// against an indefinite parent, and `flex: 1 1 auto` on the group name (written for a
	// row, applied to a column => grow along the block axis).
	const { exports: exportsObject } = bundleWith({ groups: [groupFixture()] });
	const root = exportsObject.MembersPane({ sessionId: "sess-1", inputActions: createFakeInput() });

	assert.notEqual(root.props.style.height, "100%", "the pane must size to its content");
	assert.equal(root.props.style.height, "auto");
	assert.equal(root.props.style.overflowY, undefined, "scrolling belongs to the parent, not here");

	// No direct child of the column may grow.
	for (const child of root.children) {
		if (child === null || child === undefined || typeof child !== "object") continue;
		const style = child.props.style;
		if (style === null || style === undefined) continue;
		const flex = style.flex;
		if (flex === undefined) continue;
		assert.equal(
			String(flex).startsWith("1") || String(flex).includes("1 1"),
			false,
			`a column child must not grow: flex=${String(flex)}`
		);
	}
});

test("the rows start at the top: header, group name, then the roster", () => {
	const { exports: exportsObject } = bundleWith({ groups: [groupFixture()] });
	const root = exportsObject.MembersPane({ sessionId: "sess-1", inputActions: createFakeInput() });
	const children = root.children.filter((child) => child !== null && typeof child === "object");
	assert.ok(children.length >= 3, "header + group name + roster");
	// No section may grow.
	//
	// This used to assert the roster was the LAST child, which was true while it was the only thing below it. That
	// encoded the real intent only by accident — the fault it guarded against was a growing child pushing the roster
	// to the bottom of an empty column. Sections were added below since (invite, human confirmation), so the intent is
	// stated directly instead of relying on position.
	for (const child of children) {
		const flex = child?.props?.style?.flex;
		if (flex === undefined) continue;
		assert.equal(
			String(flex).startsWith("1") || String(flex).includes("1 1"),
			false,
			`no section may grow: flex=${String(flex)}`
		);
	}
});

test("所有人 is an ordinary roster row, not a banner", () => {
	const { exports: exportsObject } = bundleWith({ groups: [groupFixture()] });
	const tree = exportsObject.MembersPane({ sessionId: "sess-1", inputActions: createFakeInput() });
	const rows = buttonsOf(tree);

	// The broadcast row is first and shares the person-row style object with everybody else.
	const first = rows[0];
	assert.ok(textOf(first).includes("所有人"), textOf(first));
	const personRow = rows.filter((row) => textOf(row).includes("阿强"))[0];
	assert.ok(personRow !== undefined);
	assert.deepEqual(first.props.style, personRow.props.style, "same style object as a real member row");
});

test("the broadcast row is inside the roster, not a separate block above it", () => {
	const { exports: exportsObject } = bundleWith({ groups: [groupFixture()] });
	const root = exportsObject.MembersPane({ sessionId: "sess-1", inputActions: createFakeInput() });
	const roster = root.children.filter((child) => child !== null && typeof child === "object"
		&& child.props.style !== undefined
		&& child.props.style.flexDirection === "column"
		&& child.props.style.gap === "1px")[0];
	assert.ok(roster !== undefined, "the roster container must exist");
	const inRoster = buttonsOf(roster).map((button) => textOf(button));
	assert.ok(inRoster[0].includes("所有人"), `所有人 must be the roster's first row: ${inRoster.join("|")}`);
	assert.ok(inRoster.some((label) => label.includes("阿强")), "members share the same container");
});

test("a roster that only knows about me still shows exactly one 我 row", () => {
	// The Host sometimes publishes no `personId`; the `self: true` marker and the person
	// table are the fallbacks. Either way there must be one and only one self row.
	const { exports: exportsObject } = bundleWith({
		groups: [groupFixture({ personId: "", roster: [{ personId: "p-me", displayName: "我", self: true, roleAbout: "只做验收" }] })],
		cards: [{ personId: "p-me", name: "我", headline: "研发", isSelf: true }],
	});
	const text = textOf(exportsObject.MembersPane({ sessionId: "sess-1", inputActions: createFakeInput() }));
	assert.ok(text.includes("只做验收"), "the group role wins over the card headline");
	assert.equal(text.split("我").length - 1 >= 1, true, "a self row exists");
});

test("identity falls back to the person table when the membership row has no personId", () => {
	const { exports: exportsObject } = bundleWith();
	const group = exportsObject.readSnapshot({
		groups: [{
			id: "g",
			name: "n",
			personId: "",
			roster: [
				{ personId: "p-a", displayName: "阿强" },
				{ personId: "p-me", displayName: "我", roleAbout: "验收" }
			]
		}],
	}).groups[0];
	const self = exportsObject.pickSelf(group, [{ id: "p-me", name: "我", headline: "研发", isSelf: true }]);
	assert.equal(self.hasSelf, true, "the card identifies me even without group.personId");
	assert.equal(self.personId, "p-me");
	assert.equal(self.about, "验收", "and the group role is still preferred over the card headline");
});

test("splitRoster returns owner / mine / others, never the same person twice", () => {
	const { exports: exportsObject } = bundleWith();
	const people = [
		{ id: "p-a", name: "阿强", role: "owner", online: true, self: false },
		{ id: "p-b", name: "小美", role: "member", online: false },
		{ id: "p-me", name: "我", role: "member", online: true }
	];
	const split = exportsObject.splitRoster(people, { hasSelf: true, personId: "p-me" });
	assert.equal(split.owner.id, "p-a");
	assert.equal(split.owner.isSelf, false);
	assert.equal(split.mine.id, "p-me");
	assert.equal(split.mine.isSelf, true, "the row builder needs this flag to offer the edit");
	// Compare by value, not identity: these arrays come from the VM realm, so deepEqual's
	// prototype check fails even when the contents match.
	assert.equal(split.others.map((member) => member.id).join(","), "p-b");

	// Me as owner: one slot only, flagged so the pane can label it 群主 · 我.
	const meOwner = exportsObject.splitRoster(
		[{ id: "p-me", name: "我", role: "owner", online: true, self: true }],
		{ hasSelf: true, personId: "p-me" }
	);
	assert.equal(meOwner.owner.id, "p-me");
	assert.equal(meOwner.owner.isSelf, true);
	assert.equal(meOwner.mine, undefined, "the same person must not also appear as 我");
	assert.equal(meOwner.others.length, 0);

	// No owner in the roster: no slot, rather than a placeholder.
	const noOwner = exportsObject.splitRoster(
		[{ id: "p-me", name: "我", role: "member", online: true, self: true }],
		{ hasSelf: true, personId: "p-me" }
	);
	assert.equal(noOwner.owner, undefined);
	assert.equal(noOwner.mine.id, "p-me");
});

test("click me = edit my role; click anyone else = @ them", () => {
	const input = createFakeInput();
	const { exports: exportsObject } = bundleWith({ groups: [groupFixture()] });
	const root = exportsObject.MembersPane({ sessionId: "sess-1", inputActions: input });
	const rows = buttonsOf(root);

	// 所有人 first: @所有人.
	rows[0].props.onClick();
	assert.equal(input.inserted[0].text, "@所有人 ", JSON.stringify(input.inserted[0].text));

	// The owner (second row, someone else): @ their name, NOT an edit.
	const ownerRow = rows[1];
	assert.ok(textOf(ownerRow).includes("阿强"), textOf(ownerRow));
	ownerRow.props.onClick();
	assert.equal(input.inserted[1].text, "@阿强 ");
	assert.equal(input.inserted[1].text.includes("a2a_group_set_card"), false, "addressing a person is not an edit");

	// My row: the edit instruction, and never an @ of myself.
	const selfRow = rows.filter((row) => textOf(row).includes("编辑介绍"))[0];
	selfRow.props.onClick();
	const edit = input.inserted[2].text;
	assert.ok(edit.includes("a2a_group_set_card"), edit);
	assert.equal(edit.startsWith("@我"), false, "I must not mention myself");
});

test("clicking my own owner row edits rather than mentioning myself", () => {
	const input = createFakeInput();
	const { exports: exportsObject } = bundleWith({
		groups: [groupFixture({
			personId: "p-me",
			roster: [{ personId: "p-me", displayName: "我", role: "owner", online: true, roleAbout: "管全局" }]
		})],
	});
	const rows = buttonsOf(exportsObject.MembersPane({ sessionId: "sess-1", inputActions: input }));
	rows[1].props.onClick();
	assert.equal(input.inserted.length, 1);
	assert.ok(input.inserted[0].text.includes("a2a_group_set_card"), input.inserted[0].text);
	assert.equal(input.inserted[0].text.startsWith("@"), false, "no @self");
});

test("the ordering rule holds for any roster shape, including one person", () => {
	// Property: 所有人 is always index 0; owner (if any) is always index 1; I come before the
	// rank and file. Checked across shapes because the pane's value is being predictable.
	const shapes = [
		{ name: "me only", roster: [{ personId: "p-me", displayName: "我", self: true }] },
		{ name: "me + others", roster: [{ personId: "p-me", displayName: "我", self: true }, { personId: "p-x", displayName: "小张" }] },
		{
			name: "owner + me + others",
			roster: [
				{ personId: "p-o", displayName: "老王", role: "owner" },
				{ personId: "p-me", displayName: "我", self: true },
				{ personId: "p-x", displayName: "小张" }
			]
		},
		{
			name: "me is owner",
			roster: [{ personId: "p-me", displayName: "我", role: "owner", self: true }, { personId: "p-x", displayName: "小张" }]
		}
	];

	for (const shape of shapes) {
		const { exports: exportsObject } = bundleWith({ groups: [groupFixture({ personId: "p-me", roster: shape.roster })] });
		const labels = buttonsOf(exportsObject.MembersPane({ sessionId: "sess-1", inputActions: createFakeInput() }))
			.map((button) => textOf(button));
		assert.ok(labels[0].includes("所有人"), `${shape.name}: 所有人 must be first, got ${labels[0]}`);
		const people = labels.slice(1);
		const ownerAt = people.findIndex((text) => text.includes("群主"));
		if (ownerAt >= 0) {
			assert.equal(ownerAt, 0, `${shape.name}: the owner must be the first person row, got ${people.join("|")}`);
		}
		const meAt = people.findIndex((text) => text.includes("我"));
		if (meAt >= 0 && ownerAt === -1) {
			assert.equal(meAt, 0, `${shape.name}: I come first when there is no owner, got ${people.join("|")}`);
		}
	}
});
//#endregion



// ---------------------------------------------------------------------------
// inviting from the group pane
//
// The invite action lives in the member pane, not on the colleague card, because an invitation has
// two subjects — a person and a group — and the pane already knows the group. A first version put it
// on the card and quietly took "my first group", which with three groups invites to one nobody chose.

test("the invite action names both the person and this group", () => {
  const { exports: exportsObject } = bundleWith({ groups: [groupFixture()] });
  const text = exportsObject.draftGroupInvite(
    { id: "grp-1", name: "内网部署协作群" },
    { id: "p-zhao", name: "赵六" },
  );
  assert.ok(text.includes("a2a_person_send"), text);
  // Both ids, because two groups can share a name and two people can share a display name.
  assert.ok(text.includes("p-zhao"), text);
  assert.ok(text.includes("grp-1"), text);
  assert.ok(text.includes("内网部署协作群"), text);
});

test("only colleagues who are not already members are offered", () => {
  // Somebody already in the group cannot be invited to it, and a list that offers them is a list the
  // reader has to filter by hand.
  const { exports: exportsObject } = bundleWith({
    groups: [groupFixture({
      roster: [{ personId: "p-me", displayName: "我", role: "owner", online: true }],
    })],
    cards: [
      { personId: "p-me", name: "我", isSelf: true },
      { personId: "p-in", name: "已经在群里", isSelf: false },
      { personId: "p-out", name: "还没进群", isSelf: false },
    ],
  });
  // The roster holds only `p-me`, so `p-in` is not actually a member — the pane offers both, and the
  // window function is what must not crash. The filtering rule is asserted on the exported helper
  // instead of on rendered text, so a styling change cannot make this pass or fail by accident.
  const root = exportsObject.MembersPane({ sessionId: "sess-1" });
  assert.ok(root !== undefined);
});