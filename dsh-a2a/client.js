/**
 * dsh-a2a — browser half (DSH Web client plugin).
 *
 * HOW THIS FILE IS LOADED (mirrors every shipped plugin bundle):
 *   window.__ModuleLoader__.load({ id: "dsh-a2a-groups", factory: (require) => exports })
 * The shell only *registers* the factory; the factory body runs later, on first
 * materialization, and the `require` handed to it is the shell's synchronous
 * lazy CJS table (react / react/jsx-runtime / react-dom / @deepseek-ai/cordis /
 * zod / @tanstack/react-virtual / @deepseek-ai/dsh-client-store /
 * @deepseek-ai/dsh-client-ui-slots / @deepseek-ai/dsh-client-ui-primitives /
 * @deepseek-ai/dsh-client-ui-dockkit). Therefore:
 *   - no `import` / `export` statements anywhere in this file (it is a script,
 *     not a module);
 *   - only the modules above may be required.
 *
 * WHAT IT RENDERS: a read-only 「协作群」 left-sidebar entry plus its central
 * panel page. Data is pull-only, from a Host-injected source:
 *   1. exports.setDataSource({ read, subscribe }) — preferred, this is the slot
 *      the Lead wires to `ctx.remote` from lib/index.js;
 *   2. window.__DSH_A2A_GROUPS__ — zero-integration fallback (plain snapshot,
 *      or an object exposing subscribe(listener)).
 * Missing / empty / malformed data always renders 「还没有加入任何群」; nothing
 * in this file may throw out of a render.
 *
 * See README-ui.md for the full data contract and integration steps.
 */
window.__ModuleLoader__.load({
	id: "dsh-a2a-groups",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** Seed-table module: real React 18.3.1 handed down by the web shell. */
		const react = require("react");
		/**
		 * Optional shared design kit. Required defensively: every primitive used
		 * below is feature-detected, so a version skew degrades to plain markup
		 * instead of breaking the panel.
		 */
		let primitives = {};
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives") || {};
		} catch (error) {
			primitives = {};
		}

		const h = react.createElement;

		//#region contract constants
		/** Global snapshot key the Host may inject without any code change. */
		const GLOBAL_KEY = "__DSH_A2A_GROUPS__";
		/** Stable slot identity: the sidebar row's `id` and the `main` panel's `key`. */
		const PANEL_ID = "a2a-groups";
		/** DOM event a Host may dispatch to push a fresh snapshot without polling. */
		const CHANGE_EVENT = "dsh-a2a:groups-changed";
		/** How many feed lines one expanded group shows. */
		const FEED_LIMIT = 20;
		/** Polling fallback while the panel is mounted (ms). Cheap: signature diff. */
		const POLL_MS = 2000;
		/** Sidebar row order; schedule uses 10 and the workspace picker sits above. */
		const PANEL_ORDER = 40;

		/**
		 * Key of the right-column members tab.
		 *
		 * One key for both the body and the title: the owner dispatches them through two
		 * slots, and a body registered under a key with no title renders as blank chrome.
		 */
		const MEMBERS_TAB_KEY = "a2a-members";

		/** Kind of the right-column members page. Also its tab key. */
		const MEMBERS_TAB_KIND = "a2a-members-page";

		/**
		 * Services the components reach for, captured in `apply(ctx)`.
		 *
		 * Components are rendered by the host rather than called by us, so they cannot take
		 * the context as an argument. One module-level handle is the smallest way to let a
		 * click handler ask the right column to open.
		 */
		const services = { sidebarRight: undefined, sidebarRightTabs: undefined };

		/**
		 * The panel's tabs, in the order a person scans them.
		 *
		 * `icon` names are resolved through {@link icon}, which prefers the product's own
		 * primitives export and falls back to geometry extracted from the shipped shell.
		 * Each tab keeps its text label: an icon-only tab bar in a 280px column makes the
		 * reader hover to find out what 「我参与」 means, and these four words are short
		 * enough that the glyph is a scanning aid rather than a replacement.
		 */
		const PANEL_TABS = [
			{ id: "all", label: "全部", icon: "list" },
			// 「我管理」, not 「我创建」: the filter is `role === "owner"`, which answers 「我是群主」 rather than 「这个群是我建
			// 的」. The two differ as soon as an existing group gains a new owner, and the old label made that state look like
			// a bug — the host said `isOwner: true` while the tab read 0.
			//
			// The `plus` glyph is kept from the previous label: it is in the fallback set, and `settings` is not (measured
			// by the tab-bar test, which requires every tab to carry a rendered icon).
			{ id: "mine", label: "我管理", icon: "plus" },
			{ id: "joined", label: "我参与", icon: "users" },
			// Groups the host OFFERS that this machine has not joined. Without it the panel could only ever show what you
			// are already in, and 「宿主上还有 5 个群可以加入」 was invisible even though `a2a_group_directory` answered it
			// — measured: a panel showing 1 group while the host listed 6.
			{ id: "discover", label: "可加入", icon: "search" },
			{ id: "cards", label: "同事名片", icon: "user" },
			// The wiring tab: a colleague who has the plugin but not the connection reads the config section here
			// instead of hunting for a file on disk. No gear glyph exists in the fallback set (list/plus/users/search/
			// user), so `list` stands in — a settings page is a list of fields.
			{ id: "settings", label: "设置", icon: "list" }
		];

		//#endregion

		//#region host bridge
		/** The object that may carry the injected snapshot (browser window). */
		function hostObject() {
			if (typeof window !== "undefined" && window !== null) return window;
			if (typeof globalThis !== "undefined" && globalThis !== null) return globalThis;
			return undefined;
		}

		/**
		 * Host-controlled data source. Either a function returning a snapshot, or a
		 * `{ read, subscribe }` object. Set through `exports.setDataSource`, which is
		 * the seam lib/index.js uses to forward `ctx.remote`.
		 */
		let dataSource;

		/**
		 * Install the Host data source (Lead integration seam).
		 * @param source - `{ read: () => snapshot, subscribe?: (fn) => () => void }`
		 *   or a bare snapshot reader function; `null`/anything else clears it.
		 */
		function setDataSource(source) {
			if (typeof source === "function") {
				dataSource = { read: source };
				return;
			}
			if (source && typeof source === "object" && typeof source.read === "function") {
				dataSource = source;
				return;
			}
			dataSource = undefined;
		}

		/** Read the raw, still-unvalidated snapshot from the best available source. */
		function readRaw() {
			if (dataSource !== undefined) {
				try {
					const value = dataSource.read();
					if (value !== undefined) return value;
				} catch (error) {
					// A Host read failure must never surface as a render error.
					warn("data source read failed", error);
				}
			}
			const host = hostObject();
			if (host === undefined) return undefined;
			try {
				return host[GLOBAL_KEY];
			} catch (error) {
				return undefined;
			}
		}

		/** Subscribe to Host pushes. Always returns a disposer, never throws. */
		function subscribeGroups(listener) {
			const disposers = [];
			if (dataSource !== undefined && typeof dataSource.subscribe === "function") {
				try {
					const off = dataSource.subscribe(listener);
					if (typeof off === "function") disposers.push(off);
				} catch (error) {
					warn("data source subscribe failed", error);
				}
			}
			const host = hostObject();
			const raw = readRaw();
			if (raw !== null && typeof raw === "object" && typeof raw.subscribe === "function") {
				try {
					const off = raw.subscribe(listener);
					if (typeof off === "function") disposers.push(off);
				} catch (error) {
					warn("snapshot subscribe failed", error);
				}
			}
			if (host !== undefined && typeof host.addEventListener === "function") {
				const handler = () => {
					listener();
				};
				try {
					host.addEventListener(CHANGE_EVENT, handler);
					disposers.push(() => {
						host.removeEventListener(CHANGE_EVENT, handler);
					});
				} catch (error) {
					/* non-DOM host: polling still covers it */
				}
			}
			return () => {
				for (const dispose of disposers) {
					try {
						dispose();
					} catch (error) {
						/* disposers are best-effort */
					}
				}
			};
		}

		/** Console warning that cannot itself throw (no console, or a frozen one). */
		function warn(message, detail) {
			try {
				if (typeof console !== "undefined" && console !== null && typeof console.warn === "function") {
					console.warn("[dsh-a2a] " + message, detail === undefined ? "" : detail);
				}
			} catch (error) {
				/* logging is never load-bearing */
			}
		}
		//#endregion

		//#region normalizers (total functions: garbage in, empty snapshot out)
		function pickString(value) {
			if (typeof value === "string") return value.trim();
			if (typeof value === "number" && Number.isFinite(value)) return String(value);
			return "";
		}

		function pickNumber(value) {
			if (typeof value === "number") return Number.isFinite(value) ? value : 0;
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				return Number.isFinite(parsed) ? parsed : 0;
			}
			return 0;
		}

		/** Accept epoch ms, epoch seconds, Date, or an ISO/parsable string. */
		function pickTime(value) {
			if (value instanceof Date) {
				const ms = value.getTime();
				return Number.isFinite(ms) ? ms : 0;
			}
			if (typeof value === "number" && Number.isFinite(value)) {
				if (value <= 0) return 0;
				return value < 1e12 ? Math.round(value * 1000) : value;
			}
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Date.parse(value);
				if (Number.isFinite(parsed)) return parsed;
				return pickTime(Number(value));
			}
			return 0;
		}

		function firstDefined(bag, keys) {
			for (const key of keys) {
				if (bag[key] !== undefined && bag[key] !== null) return bag[key];
			}
			return undefined;
		}

	/**
	 * How long a member counts as online after their last authenticated call.
	 *
	 * Mirrors the host constant. Duplicated deliberately: the panel cannot import from the
	 * plugin's own source, and a stale copy here would only change a label, not any data.
	 */
	const ONLINE_WINDOW_MS = 120000;

	/**
	 * Presence from a timestamp, never from a stored boolean.
	 *
	 * A cached roster can be an hour old. Its `online` field, if it has one, records what was
	 * true when it was fetched — so trusting it means showing a stale claim with the same
	 * confidence as a live one. `lastSeenAt` is a fact about the past and does not decay, so
	 * the answer stays correct as time passes.
	 *
	 * An absent timestamp yields `undefined`, not `false`: "we do not know" and "they are
	 * away" are different, and only one of them is ours to assert.
	 *
	 * @param {object} raw - member or card source.
	 * @returns {boolean|undefined} whether they are online, or undefined when unknown.
	 */
	function presenceOf(raw) {
		const seen = firstDefined(raw, ["lastSeenAt", "lastSeen"]);
		if (typeof seen === "number" && Number.isFinite(seen) && seen > 0) {
			return Date.now() - seen <= ONLINE_WINDOW_MS;
		}
		// A roster written before timestamps were cached carries `online` and NOTHING else. That boolean recorded
		// what was true when the roster was fetched, which may be hours ago, so honouring it means repeating a
		// stale claim with the same confidence as a live one — exactly the bug this function exists to prevent.
		//
		// The old fallback returned it. That was wrong for caches and is why an 84-minute-old roster still showed
		// a member as offline after the writer had switched to timestamps. "I do not know" is the honest answer,
		// and it is the one the panel can act on (it offers to refresh) rather than asserting a fact.
		return undefined;
	}

		/**
		 * One roster member. `personId`/`displayName` are lib/groups.js `publicMember`.
		 *
		 * `about` is that member's `roleAbout` — what they do IN THIS GROUP. It is read
		 * here rather than from the person table because it is per-group by design: the
		 * same person is "研发" in one group and "产品" in another, and the members pane
		 * shows one group, so it must show that group's answer.
		 */
		function normalizeMember(raw, index) {
			if (!raw || typeof raw !== "object") return undefined;

			const name = pickString(firstDefined(raw, ["displayName", "name", "title", "label"]));
			// Both names are accepted: this bundle is cached by the page and may talk to a Host
			// that still sends the older field. Do not drop the old one — a cached bundle and a
			// fresh Host are a normal pairing for a few navigations after an upgrade.
			const id = pickString(firstDefined(raw, ["personId", "memberId", "id", "sessionId", "key"])) || "member-" + String(index);
			// "present but empty" and "absent" mean different things: the tool leaves a field
			// alone when it is omitted, so empty == cleared. Losing that distinction would let
			// a cleared description be silently re-filled from the person table.
			const aboutRaw = firstDefined(raw, ["roleAbout", "about", "headline"]);
			return {
				id: id,
				name: name !== "" ? name : id,
				role: pickString(firstDefined(raw, ["role", "kind"])),
				roleAbout: pickString(aboutRaw),
				roleAboutKnown: aboutRaw !== undefined,
				tags: (Array.isArray(raw.tags) ? raw.tags : []).filter(function (tag) {
					return typeof tag === "string" && tag !== "";
				}),
				// Derived from the timestamp, not read from the cache: see presenceOf.
				online: presenceOf(raw),
				// Which build this member reported. Empty means unknown, which must not be rendered as agreement.
				clientVersion: pickString(firstDefined(raw, ["clientVersion", "version"])),
				self: raw.self === true || raw.isSelf === true
			};
		}

		/**
		 * One feed / last-message entry.
		 *
		 * `seq`/`msgId`/`at`/`from:{personId,displayName}`/`kind`/`text` is exactly
		 * `lib/groups.js` `publicEntry()`; the rest are conveniences for other Hosts.
		 */
		function normalizeEntry(raw, index) {
			if (!raw || typeof raw !== "object") return undefined;
			const text = pickString(firstDefined(raw, ["text", "body", "summary", "message", "content", "preview"]));
			// `from` is an object in groups.js (`{personId, displayName}`), a string elsewhere.
			const from = raw.from;
			const fromName = from !== null && typeof from === "object" ? pickString(firstDefined(from, ["displayName", "name", "personId", "memberId"])) : pickString(from);
			const senderName = fromName !== "" ? fromName : pickString(firstDefined(raw, ["senderName", "sender", "author", "name"]));
			const time = pickTime(firstDefined(raw, ["at", "time", "ts", "createdAt", "sentAt"]));
			const seq = pickNumber(firstDefined(raw, ["seq", "sequence"]));
			const id = pickString(firstDefined(raw, ["msgId", "id", "messageId"]));
			return {
				id: id !== "" ? id : seq > 0 ? "seq-" + String(seq) : "entry-" + String(index),
				seq: seq,
				text: text,
				senderName: senderName !== "" ? senderName : "未知成员",
				time: time,
				kind: pickString(firstDefined(raw, ["kind", "type"]))
			};
		}

		/** One collaboration group plus its roster and feed. */
		function normalizeGroup(raw, index) {
			if (!raw || typeof raw !== "object") return undefined;
			const id = pickString(firstDefined(raw, ["id", "groupId", "group"])) || "group-" + String(index);
			const name = pickString(firstDefined(raw, ["name", "title", "label"])) || "未命名群";

			// `roster` is the list a Session cached after calling with a member credential;
			// `members` is groups.js `members()` for a group hosted right here. Either is
			// authoritative — both came from a caller that held a credential.
			const membersRaw = Array.isArray(raw.roster)
				? raw.roster
				: Array.isArray(raw.members)
					? raw.members
					: Array.isArray(raw.memberList)
						? raw.memberList
						: [];
			const members = [];
			for (let i = 0; i < membersRaw.length; i += 1) {
				const member = normalizeMember(membersRaw[i], i);
				if (member !== undefined) members.push(member);
			}

			// `feedTail` is what lib/groups.js `snapshot()` calls it; `feed`/`messages` are conveniences.
			const feedRaw = Array.isArray(raw.feed) ? raw.feed : Array.isArray(raw.messages) ? raw.messages : Array.isArray(raw.feedTail) ? raw.feedTail : [];
			const feed = [];
			for (let i = 0; i < feedRaw.length; i += 1) {
				const entry = normalizeEntry(feedRaw[i], i);
				if (entry !== undefined) feed.push(entry);
			}
			feed.sort((left, right) => left.time - right.time || left.seq - right.seq);
			const recentFeed = feed.length > FEED_LIMIT ? feed.slice(feed.length - FEED_LIMIT) : feed;

			// The Host no longer sends message bodies — deliberately: the snapshot is written into the page
			// HTML, and a group member reading the group is not the same as the body appearing in every
			// page render. So the summary is assembled from routing facts.
			//
			// `lastFromName` names who spoke without quoting them. A system line has no author, which is
			// why it is carried as its own flag rather than inferred from an empty name — "nobody said
			// anything" and "the system said something" are different statements.
			const lastFrom = pickString(firstDefined(raw, ["lastFromName", "lastFrom"]));
			const lastIsSystem = raw.lastIsSystem === true;
			const lastAt = pickTime(firstDefined(raw, ["lastTime", "lastPostAt", "lastMessageAt"]));

			// An older Host (or a fixture written against one) sends a whole `lastPost` object including
			// `text`. Its author and time are useful; its body must be dropped here rather than carried
			// into the summary, or the leak returns through the compatibility path where nobody looks.
			// The oldest explicit form: a whole `lastMessage` object. Its `from`/`at` are useful and its
			// `body`/`text` are dropped on the way in.
			const legacyExplicit = raw.lastMessage !== null && typeof raw.lastMessage === "object"
				? raw.lastMessage
				: undefined;
			const legacyLast = raw.lastPost !== null && typeof raw.lastPost === "object" ? raw.lastPost : undefined;
			const legacyFrom = legacyLast === undefined
				? ""
				: pickString(firstDefined(legacyLast, ["from", "senderName", "displayName"]))
					|| (legacyLast.from !== null && typeof legacyLast.from === "object"
						? pickString(legacyLast.from.displayName)
						: "");
			const legacyAt = legacyLast === undefined ? 0 : pickTime(firstDefined(legacyLast, ["at", "time"]));

			// The oldest shape: a feed array. Its last entry names an author and a time, and its `text` is
			// dropped — a compatibility path that forwards the body is the same leak in a place nobody
			// audits.
			const feedTailAuthor = (() => {
				if (lastFrom !== "" && lastAt > 0) return { from: "", at: 0 };
				if (!Array.isArray(raw.feed) || raw.feed.length === 0) return { from: "", at: 0 };
				const last = raw.feed[raw.feed.length - 1];
				if (last === null || typeof last !== "object") return { from: "", at: 0 };
				const name = pickString(firstDefined(last, ["senderName", "fromName"]))
					|| (last.from !== null && typeof last.from === "object" ? pickString(last.from.displayName) : "")
					|| (typeof last.from === "string" ? pickString(last.from) : "");
				return { from: name, at: pickTime(firstDefined(last, ["at", "time"])) };
			})();

			const explicitFrom = legacyExplicit === undefined
				? ""
				: pickString(firstDefined(legacyExplicit, ["senderName", "fromName"]))
					|| (legacyExplicit.from !== null && typeof legacyExplicit.from === "object"
						? pickString(legacyExplicit.from.displayName)
						: pickString(legacyExplicit.from));
			const explicitAt = legacyExplicit === undefined ? 0 : pickTime(firstDefined(legacyExplicit, ["at", "time"]));

			const effectiveFrom = lastFrom !== "" ? lastFrom
				: (legacyFrom !== "" ? legacyFrom
					: (explicitFrom !== "" ? explicitFrom : feedTailAuthor.from));
			const effectiveAt = lastAt > 0 ? lastAt
				: (legacyAt > 0 ? legacyAt
					: (explicitAt > 0 ? explicitAt : feedTailAuthor.at));

			// Kept as an object so every existing renderer keeps working; `text` is intentionally
			// absent, and `from` carries the author instead.
			// An author or a system marker is required. A timestamp on its own is not evidence of a message:
			// it may be a settings change, and rendering "有新消息" for it would invent a line the group never
			// had. Ordering reads `lastTime` separately, so nothing is lost.
			const hasSummary = effectiveFrom !== "" || lastIsSystem === true;
			let lastMessage = hasSummary === false
				? undefined
				: {
					id: "",
					seq: 0,
					time: effectiveAt,
					from: effectiveFrom,
					// `senderName` is the name other renderers read; kept because the card, the feed rows and
					// the tests all address an author by it.
					senderName: effectiveFrom,
					// Never the message body. This string is the whole summary the card shows.
					text: lastIsSystem === true
						? "群里有新消息"
						: (effectiveFrom === "" ? "有新消息" : effectiveFrom + " 发来一条消息"),
					system: lastIsSystem
				};

			const declaredMemberCount = pickNumber(firstDefined(raw, ["memberCount", "membersCount", "memberTotal"]));
			const unreadCount = Math.max(0, Math.round(pickNumber(firstDefined(raw, ["unreadCount", "unread", "unreadTotal"]))));

			return {
				id: id,
				name: name,
				// `topic` is the secondary line in groups.js; shown as the card tooltip.
				topic: pickString(firstDefined(raw, ["topic", "description"])),
				memberCount: declaredMemberCount > 0 ? Math.round(declaredMemberCount) : members.length,
				unreadCount: unreadCount,
				// The group's message head.
				//
				// SEVENTH field lost to this exact shape of bug: the Host publishes it, this whitelist mapper does not
				// copy it, so every reader sees `undefined`. Here the consequence was a change signature that could not
				// notice a new message — the panel received fresh data, computed the same signature, and re-rendered
				// nothing. Reported as 「群成员没有刷新」, which looked like a data problem and was a mapper problem.
				lastSeq: typeof raw.lastSeq === "number" && Number.isFinite(raw.lastSeq) ? raw.lastSeq : 0,
				lastMessage: lastMessage,
				lastTime: lastMessage === undefined ? 0 : lastMessage.time,
				members: members,
				// No feed array: the Host does not send one any more, and keeping an always-empty field invites
			// a future renderer to depend on it.
			feed: recentFeed,
				// `role` is the permission bit (owner | member). It decides which section
				// the group belongs to, because the ACTIONS differ: an owner approves and
				// invites, a member only reads and posts.
				role: pickString(firstDefined(raw, ["role", "permission"])) || "member",
				// A group that exists only as a directory row: not joined, so it belongs in
				// "discover" and its only action is "ask to join".
				discovered: raw.discovered === true || raw.joined === false,
				// Whether this machine already holds a credential for this group from ANOTHER Session — which is what
				// makes rejoining possible without an invite. Also a whitelist mapper site: adding it to the host snapshot
				// without adding it here is how a field silently never reaches the pane.
				canRejoinAs: raw.canRejoinAs === true,
				knownAs: pickString(raw.knownAs),
				knownSessionId: pickString(raw.knownSessionId),
				// Which Session this membership belongs to, when the Host says.
				sessionId: pickString(firstDefined(raw, ["sessionId", "session"])),
				// Every Session holding a credential for this group. The Host publishes one row per GROUP now, so this
				// is how a conversation that is not the newest holder still learns the group is its own — and how the
				// rejoin offer stays reachable for it.
				knownSessionIds: (Array.isArray(raw.knownSessionIds) ? raw.knownSessionIds : []).filter(
					function (id) { return typeof id === "string" && id !== ""; },
				),
				// My own person id IN THIS GROUP, when the Host puts it on the membership row
				// (`lib/index.js` does). It is what lets the pane say "这是你" before any
				// roster has been fetched, which is the normal state on first open.
				personId: pickString(firstDefined(raw, ["personId", "memberId"])),
				muted: raw.muted === true || raw.mute === true,
				// Health flags the Host sends about THIS membership. They were being dropped here,
				// which is why the stale-cache and unreachable warnings never appeared: the Host
				// supplied the facts and the normaliser discarded them before any renderer saw them.
				//
				// `rosterStale` means the cached roster is older than the bound, so the names and
				// presence count may have moved on. `unreachableAt` means the Host refused the last
				// call, which is a stronger claim worth its own, louder line.
				rosterStale: raw.rosterStale === true,
				unreachableAt: Number.isFinite(raw.unreachableAt) ? raw.unreachableAt : 0,
			};
		}

		/**
		 * Coerce anything the Host (or a future `ctx.remote` read) hands over into
		 * the shape the components consume.
		 * @param raw - array of groups, `{ groups: [...] }`, `{ items: [...] }`, or junk.
		 * @returns `{ groups, updatedAt, unreadTotal, ok }` — always safe to spread.
		 */
		function readSnapshot(raw) {
			const empty = {
				groups: [],
				cards: [],
				updatedAt: 0,
				unreadTotal: 0,
				ok: false
			};
			try {
				const container = Array.isArray(raw) ? raw : raw !== null && typeof raw === "object" ? (Array.isArray(raw.groups) ? raw.groups : Array.isArray(raw.items) ? raw.items : []) : [];
				const groups = [];
				for (let i = 0; i < container.length; i += 1) {
					const group = normalizeGroup(container[i], i);
					if (group !== undefined) groups.push(group);
				}
				let unreadTotal = 0;
				for (const group of groups) unreadTotal += group.unreadCount;
				const updatedAt = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? pickTime(firstDefined(raw, ["updatedAt", "time", "ts"])) : 0;
				return {
					groups: groups,
					cards: readCards(raw),
					// This instance build, sent by the Host because the page cannot read package.json.
					selfVersion: raw !== null && typeof raw === "object" && !Array.isArray(raw) ? pickString(raw.selfVersion) : "",
					updatedAt: updatedAt,
					unreadTotal: unreadTotal,
					// The paste-ready config section, rendered by the Host. Passed through as an opaque object — the
					// page shows its text and masked fields, it never parses or re-renders them.
					settings: raw !== null && typeof raw === "object" && !Array.isArray(raw) && raw.settings !== undefined
						? raw.settings
						: undefined,
					ok: true
				};
			} catch (error) {
				return empty;
			}
		}

		/** Current snapshot straight from the Host, normalized. */
		/**
		 * Replace the injected groups table with a freshly read one.
		 *
		 * The page renders from a global the Host injects once, plus a poll that re-reads it. A refresh performed
		 * over RPC changes the LEDGER, not that global — so without this the new data would exist on disk and the
		 * screen would keep drawing the old copy until the next full page load.
		 *
		 * @param {Array} groups - the `groups` array a refresh returned.
		 * @returns {void}
		 */
		/**
		 * Write a fresh group list into the host global.
		 *
		 * `directoryError` rides along when known, so the panel can say WHY the 「可加入」 tab is empty — a network failure
		 * and an empty directory are different facts that both render as an empty list, and only one of them is good news.
		 * Omitted by callers that only have the array, which keeps the local read path unchanged.
		 */
		function replaceGroups(groups, directoryError, cards) {
			if (!Array.isArray(groups)) return;
			const host = hostObject();
			if (host === undefined) return;
			try {
				const existing = host[GLOBAL_KEY];
				const patch = { groups: groups };
				if (typeof directoryError === "string") patch.directoryError = directoryError;
				// Cards follow the same rule as groups: an array from the server replaces the page's copy; an
				// absent field leaves it alone, so an older Host that does not poll cards changes nothing here.
				if (Array.isArray(cards)) patch.cards = cards;
				const next = existing !== null && typeof existing === "object" && !Array.isArray(existing)
					? Object.assign({}, existing, patch)
					: patch;
				host[GLOBAL_KEY] = next;
			} catch (error) {
				// A frozen global would make this throw; the poll will pick the change up on the next load instead.
				warn("could not replace groups", error);
			}
			// Wake every subscriber the same way a Host-side change would, so the poll is not the only path to a
			// re-render. Falls back silently on a non-DOM host; the interval still covers it.
			try {
				host.dispatchEvent(new Event(CHANGE_EVENT));
			} catch (error) {
				/* non-DOM host: the poll still covers it */
			}
		}

		function currentSnapshot() {
			return readSnapshot(readRaw());
		}

		/** Cheap change signature so polling only re-renders on real movement. */
		function signatureOf(snapshot) {
			let signature = String(snapshot.groups.length) + "|" + String(snapshot.unreadTotal);
			for (const group of snapshot.groups) {
				signature += "|" + group.id + ":" + String(group.memberCount) + ":" + String(group.unreadCount) + ":" + String(group.lastTime);
				// `lastSeq` is the group head. It moves on every post and is what the user actually watches for —
				// 「有新消息了吗」. It was NOT in the signature, so a new message left every field here unchanged
				// (same member count, same lastTime when the snapshot's cached tail had not caught up) and the panel
				// kept the old rendering: reported as "the list does not refresh while I am operating".
				signature += ":q" + String(group.lastSeq);
				// A refresh can change the roster WITHOUT changing any of the fields above — same member count, same
				// last activity, different names or brand-new presence timestamps. Without these two the panel would
				// receive the new data, compute the same signature, and stay on the old rendering.
				signature += ":s" + (group.rosterStale === true ? "1" : "0");
				const roster = Array.isArray(group.members) ? group.members : [];
				for (const member of roster) {
					signature += ":" + String(member.id) + "/" + String(member.name) + "/" + String(member.online);
				}
				const last = group.lastMessage;
				if (last !== undefined) signature += ":" + last.id + ":" + String(last.text.length);
			}
			// Card names and headlines: a profile save moves only these, and a signature blind to them would
			// receive the new cards and keep rendering the old ones.
			const cards = Array.isArray(snapshot.cards) ? snapshot.cards : [];
			for (const card of cards) {
				signature += "|c" + String(card.id) + "/" + String(card.name) + "/" + String(card.headline);
			}
			return signature;
		}
		//#endregion

		//#region time formatting (no dependency on primitive time helpers)
		function pad2(value) {
			return value < 10 ? "0" + String(value) : String(value);
		}

		/** Compact Chinese relative time, e.g. 「刚刚」「3 分钟前」「昨天 14:05」. */
		function formatTime(time) {
			if (!Number.isFinite(time) || time <= 0) return "";
			const now = Date.now();
			const delta = now - time;
			if (delta >= 0 && delta < 60 * 1000) return "刚刚";
			if (delta >= 60 * 1000 && delta < 60 * 60 * 1000) return String(Math.floor(delta / (60 * 1000))) + " 分钟前";
			if (delta >= 60 * 60 * 1000 && delta < 24 * 60 * 60 * 1000) return String(Math.floor(delta / (60 * 60 * 1000))) + " 小时前";
			const then = new Date(time);
			const today = new Date(now);
			const clock = pad2(then.getHours()) + ":" + pad2(then.getMinutes());
			const sameDay = then.getFullYear() === today.getFullYear() && then.getMonth() === today.getMonth() && then.getDate() === today.getDate();
			if (sameDay) return clock;
			const yesterday = new Date(now - 24 * 60 * 60 * 1000);
			const isYesterday = then.getFullYear() === yesterday.getFullYear() && then.getMonth() === yesterday.getMonth() && then.getDate() === yesterday.getDate();
			if (isYesterday) return "昨天 " + clock;
			if (then.getFullYear() === today.getFullYear()) return String(then.getMonth() + 1) + "月" + String(then.getDate()) + "日 " + clock;
			return String(then.getFullYear()) + "-" + pad2(then.getMonth() + 1) + "-" + pad2(then.getDate());
		}

		/** One-line preview: collapse newlines, clamp length. */
		function previewText(text, limit) {
			const flat = String(text === undefined || text === null ? "" : text).replace(/\s+/g, " ").trim();
			if (flat === "") return "（暂无内容）";
			const max = typeof limit === "number" && limit > 0 ? limit : 60;
			return flat.length > max ? flat.slice(0, max) + "…" : flat;
		}
		//#endregion

		//#region styles (inline only: no CSS file, no build artifacts)
		const S = {
			root: {
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				padding: "16px",
				height: "100%",
				minHeight: "0",
				overflowY: "auto",
				boxSizing: "border-box",
				color: "inherit",
				font: "13px/1.5 inherit"
			},
			header: {
				display: "flex",
				alignItems: "baseline",
				gap: "8px",
				flexWrap: "wrap"
			},
			title: {
				fontSize: "15px",
				fontWeight: "600",
				margin: 0
			},
			hint: {
				fontSize: "12px",
				opacity: 0.55
			},
			empty: {
				display: "flex",
				flexDirection: "column",
				gap: "6px",
				alignItems: "flex-start",
				padding: "20px 16px",
				borderRadius: "10px",
				border: "1px dashed rgba(127,127,127,0.35)",
				opacity: 0.85
			},
			emptyTitle: {
				fontSize: "14px",
				fontWeight: "600",
				margin: 0
			},
			/* Dimmed illustration for the empty state: present enough to soften the panel,
			   faint enough that it never competes with the sentence under it. */
			emptyIcon: {
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				marginBottom: "2px",
				opacity: 0.3,
				color: "currentColor"
			},
			emptyBody: {
				fontSize: "12px",
				opacity: 0.6,
				margin: 0
			},
			card: {
				borderRadius: "10px",
				border: "1px solid rgba(127,127,127,0.25)",
				overflow: "hidden",
				background: "transparent"
			},
			cardHead: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				width: "100%",
				padding: "9px 11px",
				border: "none",
				background: "transparent",
				color: "inherit",
				cursor: "pointer",
				textAlign: "left",
				font: "inherit"
			},
			chevron: {
				flex: "none",
				display: "inline-flex",
				alignItems: "center",
				opacity: 0.55,
				color: "inherit"
			},
			groupName: {
				flex: "1 1 auto",
				minWidth: 0,
				fontWeight: "600",
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis"
			},
			badge: {
				flex: "none",
				minWidth: "17px",
				padding: "0 5px",
				borderRadius: "9px",
				textAlign: "center",
				fontSize: "11px",
				lineHeight: "17px",
				background: "rgba(240,80,80,0.18)",
				color: "inherit",
				fontWeight: "600"
			},
			/* A count with a glyph instead of a word: 「3 人」 became an icon plus a number,
			   which is how every IM client shows a roster size and costs one third the width. */
			metaChip: {
				flex: "none",
				display: "inline-flex",
				alignItems: "center",
				gap: "3px",
				fontSize: "11px",
				opacity: 0.55,
				lineHeight: "1"
			},
			memberCount: {
				flex: "none",
				display: "inline-flex",
				alignItems: "center",
				gap: "3px",
				fontSize: "11px",
				opacity: 0.55
			},
			cardBody: {
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				padding: "0 11px 11px"
			},
			last: {
				display: "flex",
				gap: "6px",
				fontSize: "12px",
				opacity: 0.72,
				minWidth: 0
			},
			lastWho: {
				flex: "none",
				fontWeight: "600"
			},
			lastText: {
				flex: "1 1 auto",
				minWidth: 0,
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis"
			},
			lastTime: {
				flex: "none",
				fontSize: "11px",
				opacity: 0.7
			},
			sectionLabel: {
				fontSize: "11px",
				letterSpacing: "0.04em",
				textTransform: "uppercase",
				opacity: 0.5,
				margin: 0
			},
			memberRow: {
				display: "flex",
				flexWrap: "wrap",
				gap: "4px"
			},
			chip: {
				padding: "1px 7px",
				borderRadius: "9px",
				border: "1px solid rgba(127,127,127,0.3)",
				fontSize: "11px",
				opacity: 0.85
			},
			feed: {
				display: "flex",
				flexDirection: "column",
				gap: "5px",
				margin: 0,
				padding: 0,
				listStyle: "none"
			},
			feedItem: {
				display: "flex",
				gap: "6px",
				fontSize: "12px",
				minWidth: 0
			},
			feedWho: {
				flex: "none",
				fontWeight: "600",
				opacity: 0.85
			},
			feedText: {
				flex: "1 1 auto",
				minWidth: 0,
				wordBreak: "break-word",
				opacity: 0.78
			},
			sidebarGlyph: {
				position: "relative",
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				lineHeight: 0
			},
			sidebarBadge: {
				position: "absolute",
				top: "-4px",
				right: "-6px",
				minWidth: "12px",
				height: "12px",
				padding: "0 3px",
				borderRadius: "6px",
				fontSize: "9px",
				lineHeight: "12px",
				textAlign: "center",
				background: "rgba(240,80,80,0.9)",
				color: "#fff",
				fontWeight: "700"
			}
		};
		//#endregion

		//#region hooks
		/** Live snapshot: initial read + Host subscription + cheap polling. */
		function useSnapshot() {
			const [snapshot, setSnapshot] = react.useState(currentSnapshot);
			react.useEffect(() => {
				let signature = signatureOf(snapshot);
				let disposed = false;

				/** Re-read from the injected global, which the Host may have refreshed in place. */
				const readLocal = () => {
					const next = currentSnapshot();
					const nextSignature = signatureOf(next);
					if (nextSignature === signature) return false;
					signature = nextSignature;
					setSnapshot(next);
					return true;
				};

				// Pull the CURRENT table over RPC.
				//
				// The injected global is written once, when the page is rendered, and then never again — so polling it
				// only ever re-read the same frozen value. The panel therefore showed nothing an operation changed
				// until the reader reloaded the whole page, which is exactly what was reported: "I could not see the
				// members while operating, only after refreshing".
				//
				// Now the poll asks the Host, writes what comes back into that global, and lets the normal render path
				// pick it up. Falls back silently to the local read when the RPC channel is absent, so a Host without
				// Connection keeps working exactly as before.
				const pull = () => {
					if (typeof panelRpcCaller !== "function") {
						readLocal();
						return;
					}
					panelRpcCaller("/a2a-panel", "groups", {}).then(function (result) {
						if (disposed) return;
						if (result !== null && result !== undefined && result.ok === true) {
							const value = result.value;
							const groups = value !== undefined && value !== null ? value.groups : undefined;
							const directoryError = value !== undefined && value !== null && typeof value.directoryError === "string"
								? value.directoryError
								: "";
							// `replaceGroups` refuses anything that is not an array, and that refusal is what made this
							// whole fix do nothing for an hour: the endpoint reported success while handing back the
							// wrong object, so every poll wrote nothing and the page kept its load-time snapshot. Warn
							// rather than fail silently — an unusable body is a broken endpoint, not a quiet no-op.
							if (!Array.isArray(groups)) {
								warn("panel poll returned no group array", value);
							}
							// Cards ride the same poll when the Host sent them. A profile save used to stay invisible
							// until a full reload, because the page's card copy was frozen at load time; writing the
							// polled cards over the injected copy is what makes "save → see it" work without one.
							const cards = value !== undefined && value !== null && Array.isArray(value.cards) ? value.cards : undefined;
							replaceGroups(groups, directoryError, cards);
						}
						readLocal();
					}).catch(function () {
						// A failed pull must not stop the panel: the local read still covers the common case.
						if (!disposed) readLocal();
					});
				};

				const dispose = subscribeGroups(readLocal);
				let timer;
				if (typeof window !== "undefined" && window !== null && typeof window.setInterval === "function") {
					timer = window.setInterval(pull, POLL_MS);
				}
				return () => {
					disposed = true;
					if (typeof dispose === "function") dispose();
					if (timer !== undefined && typeof window.clearInterval === "function") window.clearInterval(timer);
				};
			}, []);
			return snapshot;
		}

		/** Expand/collapse memory for the group cards. */
		function useExpanded() {
			const [expanded, setExpanded] = react.useState({});
			const toggle = (id) => {
				setExpanded((previous) => {
					const next = {};
					for (const key of Object.keys(previous)) if (key !== id) next[key] = previous[key];
					if (previous[id] !== true) next[id] = true;
					return next;
				});
			};
			return [expanded, toggle];
		}

		/**
		 * A single boolean that survives re-renders.
		 *
		 * Not persisted on purpose: a strip that remembered being open would surprise
		 * someone who collapsed it in a different Session, and collapsed is the quiet
		 * default for something that sits above every composer.
		 */

		/**
		 * Insert \`@name \` into the composer, through the owner's two-step API.
		 *
		 * \`captureInsertion()\` first, then \`insertText(text, span)\`: the span carries the
		 * selection and the draft revision, so an insert into a draft that changed since the
		 * click is REFUSED rather than applied in the wrong place. Passing text alone does
		 * not throw — it silently returns false — which is why the one-argument version
		 * looked like a dead button.
		 *
		 * Returns true when something was actually written.
		 */
		function insertMention(inputActions, name) {
			const text = "@" + name + " ";
			try {
				if (inputActions === null || inputActions === undefined) return false;
				if (typeof inputActions.captureInsertion === "function"
					&& typeof inputActions.insertText === "function") {
					const span = inputActions.captureInsertion();
					return inputActions.insertText(text, span) === true;
				}
				// Last resort for a Host that only offers a whole-draft setter. It replaces
				// the draft, which is why it is the fallback and not the first choice.
				if (typeof inputActions.setDraft === "function") {
					inputActions.setDraft(text);
					return true;
				}
				return false;
			} catch (error) {
				reportUnavailable("inputActions.insertText", error);
				return false;
			}
		}

		/**
		 * Component-local state that survives re-renders.
		 *
		 * Deliberately unpersisted: the panel keeps its active tab and its tag filter here,
		 * and neither should outlive the page. A remembered tag filter would silently hide
		 * colleagues after a reload, which is worse than losing the filter.
		 */
		function useLocalState(initial) {
			const [value, setValue] = react.useState(initial === undefined ? false : initial);
			return {
				value: value,
				set: setValue,
				/** The active tag filter, when this state holds a {tab, tag} pair. */
				get tag() {
					return value !== null && typeof value === "object" ? value.tag : "";
				}
			};
		}
		//#endregion

		//#region icons
		/**
		 * Icon layer.
		 *
		 * ## Where these come from
		 *
		 * `@dsh-client-ui-primitives` is a BUILD-TIME VENDORED module in the web shell: it
		 * is not resolvable from disk (there is no `lib/index.js` anywhere under the `dsh`
		 * install), but the shell's seed table binds it to the real package, so
		 * `require("@dsh-client-ui-primitives")` is the only correct way in. It is required
		 * once at the top of the factory and read through `primitives.IconXxxYyy`.
		 *
		 * The bundle's icon components share one contract, verified in the shipped shell:
		 *
		 *   ({ size = 16, className, strokeWidth }) => svg{ width: size, height: size,
		 *     viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", strokeWidth, ... }
		 *
		 * Two consequences for the code below:
		 *  - every icon is already 16x16 and `aria-hidden`, so we pass `size` and nothing else
		 *    decorative;
		 *  - the variant suffix is weight, not shape: `...Regular` is 1px and `...Medium` is
		 *    1.3px. The geometry is identical, so a fallback drawn at 1px matches Regular.
		 *
		 * ## Why every icon has an inline-SVG fallback
		 *
		 * The primitives package is versioned with the shell. A profile whose shell predates
		 * an icon, or a future rename, would otherwise render a blank square where an
		 * affordance used to be — the worst failure mode for a clickable row. Each fallback
		 * below is not invented: its geometry was extracted from the shipped shell bundle
		 * with `scripts/extract-icon-paths.mjs`, so a fallback is pixel-identical to the
		 * product icon it stands in for. Every icon in this table is on the 16x16 grid, but
		 * each fallback still carries its own `viewBox` because the product is not uniformly
		 * 16x16 in general (`IconCheckCircleFillRegular` is 36x36).
		 *
		 * ## Icons used, and what each one means here
		 *
		 * | export                          | drawn as | used for                              |
		 * |---------------------------------|----------|---------------------------------------|
		 * | IconFlatListOutlineRegular      | list     | tab 「全部」                           |
		 * | IconPlusOutlineRegular          | plus     | tab 「我管理」                         |
		 * | IconUsersOutlineRegular         | 2 people | tab 「我参与」/ members header / count |
		 * | IconUserOutlineRegular          | 1 person | tab 「同事名片」                       |
		 * | IconChevronDownOutlineRegular   | ⌄        | expanded group card                   |
		 * | IconChevronRightOutlineRegular  | ›        | collapsed group card                  |
		 * | IconNewChatOutlineRegular       | speech   | empty state 「还没有加入任何群」         |
		 *
		 * `IconEditOutlineRegular` is mapped for the 「改我的名片」 / edit affordances; the
		 * members rows use a text chip (`编辑介绍`) instead, because a 12px pencil next to a
		 * name reads as "rename this person" rather than "describe yourself".
		 *
		 * `@所有人` deliberately has **no** icon: it renders a literal `@`, which is the
		 * universal broadcast marker and is exactly the character the click inserts.
		 */
		const ICONS = {
			list: "IconFlatListOutlineRegular",
			plus: "IconPlusOutlineRegular",
			users: "IconUsersOutlineRegular",
			user: "IconUserOutlineRegular",
			chevronDown: "IconChevronDownOutlineRegular",
			chevronRight: "IconChevronRightOutlineRegular",
			edit: "IconEditOutlineRegular",
			chat: "IconNewChatOutlineRegular"
		};

		/**
		 * Fallback geometry, copied out of the shipped shell bundle.
		 *
		 * `paths` are attribute maps; `attrs` are the values the shell's shared base svg
		 * puts on the <svg> element and its children inherit (`stroke`, `strokeLinecap`).
		 * `viewBox` is per icon because not all of them use the 16x16 grid.
		 */
		const ICON_FALLBACKS = {
			IconFlatListOutlineRegular: {
				viewBox: "0 0 16 16",
				attrs: { fill: "none", stroke: "currentColor", strokeLinecap: "round" },
				paths: [{ d: "M6 3.5h7.5M6 8h7.5M6 12.5h7.5" }, { d: "M2.6 3.5h.01M2.6 8h.01M2.6 12.5h.01" }]
			},
			IconPlusOutlineRegular: {
				viewBox: "0 0 16 16",
				attrs: { fill: "none", stroke: "currentColor" },
				paths: [{ d: "M8 2V14", stroke: "currentColor" }, { d: "M2 8H14", stroke: "currentColor" }]
			},
			IconUsersOutlineRegular: {
				viewBox: "0 0 16 16",
				attrs: { fill: "none", stroke: "currentColor" },
				paths: [
					{ d: "M6 8.25C7.51878 8.25 8.75 7.01878 8.75 5.5C8.75 3.98122 7.51878 2.75 6 2.75C4.48122 2.75 3.25 3.98122 3.25 5.5C3.25 7.01878 4.48122 8.25 6 8.25Z", stroke: "currentColor" },
					{ d: "M1 14.5C1 11.5 3.5 10.25 6 10.25C8.5 10.25 11 11.5 11 14.5", stroke: "currentColor" },
					{ d: "M10.5 2.9C11.65 3.35 12.45 4.35 12.45 5.5C12.45 6.65 11.65 7.65 10.5 8.1", stroke: "currentColor" },
					{ d: "M12.4 10.6C13.9 11.3 15 12.6 15 14.5", stroke: "currentColor" }
				]
			},
			IconUserOutlineRegular: {
				viewBox: "0 0 16 16",
				attrs: { fill: "none", stroke: "currentColor" },
				paths: [
					{ d: "M8 8.25C9.51878 8.25 10.75 7.01878 10.75 5.5C10.75 3.98122 9.51878 2.75 8 2.75C6.48122 2.75 5.25 3.98122 5.25 5.5C5.25 7.01878 6.48122 8.25 8 8.25Z", stroke: "currentColor" },
					{ d: "M2.5 14.5C2.5 11.5 5.25 10.25 8 10.25C10.75 10.25 13.5 11.5 13.5 14.5", stroke: "currentColor" }
				]
			},
			IconChevronDownOutlineRegular: {
				viewBox: "0 0 16 16",
				attrs: { fill: "none", stroke: "currentColor" },
				paths: [{ d: "M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6", stroke: "currentColor" }]
			},
			IconChevronRightOutlineRegular: {
				viewBox: "0 0 16 16",
				attrs: { fill: "none", stroke: "currentColor" },
				paths: [{ d: "M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4", stroke: "currentColor" }]
			},
			IconEditOutlineRegular: {
				viewBox: "0 0 16 16",
				attrs: { fill: "none", stroke: "currentColor" },
				paths: [
					{ d: "M8.85596 2.69971H4.19971C3.37141 2.69971 2.69992 3.37146 2.69971 4.19971V11.8003C2.69992 12.6285 3.37141 13.3003 4.19971 13.3003H11.8003C12.6283 13.2999 13.3001 12.6283 13.3003 11.8003V7.89893H14.3003V11.8003C14.3001 13.1806 13.1806 14.2999 11.8003 14.3003H4.19971C2.81913 14.3003 1.69992 13.1808 1.69971 11.8003V4.19971C1.69992 2.81918 2.81913 1.69971 4.19971 1.69971H8.85596V2.69971Z", fill: "currentColor" },
					{ d: "M7.7849 8.23878L13.888 2.13574", stroke: "currentColor" }
				]
			},
			IconNewChatOutlineRegular: {
				viewBox: "0 0 16 16",
				attrs: { fill: "none", stroke: "currentColor" },
				paths: [
					{ d: "M2.37091 11.2501C1.58745 9.89288 1.32067 8.29835 1.61969 6.76006C1.91872 5.22177 2.76342 3.8433 3.99826 2.87846C5.2331 1.91362 6.77494 1.42737 8.33988 1.50925C9.90482 1.59113 11.3875 2.23562 12.5149 3.32406C13.6425 4.41269 14.3387 5.87206 14.4754 7.4334C14.612 8.99474 14.18 10.5529 13.2587 11.8209C12.3375 13.0888 10.9891 13.9813 9.46194 14.3337C8.18691 14.628 6.85895 14.5294 5.64989 14.0605C5.1712 13.8748 4.76962 13.4932 4.26534 13.3967C3.67413 13.2835 2.95257 13.5598 2.03794 14.3337", stroke: "currentColor" },
					{ d: "M8 5V11", stroke: "currentColor" },
					{ d: "M5 8H11", stroke: "currentColor" }
				]
			},
		};

		/** Narrow a primitives export to something callable as a component. */
		function isRenderable(value) {
			return value !== null && value !== undefined && (typeof value === "function" || typeof value === "object");
		}

		/**
		 * Draw one icon.
		 *
		 * Resolves, in order: the primitives export for `name`, then the extracted
		 * fallback geometry, then nothing (`null`). It never throws: an icon is decoration,
		 * and a missing one must cost the glyph, not the row that carries the action.
		 *
		 * @param {string} name - key into {@link ICONS}, or a raw `Icon*` export name.
		 * @param {number} [size] - pixel size; the product default is 16.
		 * @returns {object|null} a vnode, or null when neither source has the icon.
		 */
		function icon(name, size) {
			const exportName = ICONS[name] === undefined ? name : ICONS[name];
			const px = typeof size === "number" && size > 0 ? size : 14;
			try {
				const component = primitives[exportName];
				if (isRenderable(component)) return h(component, { size: px });
			} catch (error) {
				/* a throwing getter must fall through to the drawn fallback */
			}
			const shape = ICON_FALLBACKS[exportName];
			if (shape === undefined) return null;
			const attrs = Object.assign(
				{
					width: px,
					height: px,
					viewBox: shape.viewBox,
					strokeWidth: 1,
					strokeLinecap: shape.attrs.strokeLinecap === undefined ? "round" : shape.attrs.strokeLinecap,
					strokeLinejoin: "round",
					// Per the product contract: icons are decoration. The accessible label lives on
					// the button's `title`, never on the glyph.
					"aria-hidden": "true",
					focusable: "false",
					style: { flex: "0 0 auto", display: "block", color: "currentColor" }
				},
				shape.attrs
			);
			return h(
				"svg",
				attrs,
				shape.paths.map(function (shapeSpec, index) {
					const tag = shapeSpec.circle === undefined ? "path" : "circle";
					const spec = shapeSpec.circle === undefined ? shapeSpec : shapeSpec.circle;
					return h(tag, Object.assign({ key: "p" + String(index) }, spec));
				})
			);
		}

		/** `icon()` sized and styled for a text-sized inline slot. */
		function inlineIcon(name, size) {
			const drawn = icon(name, typeof size === "number" && size > 0 ? size : 12);
			return drawn;
		}
		//#endregion

		//#region components
		/**
		 * Empty state required by the contract: never an error, never a spinner.
		 *
		 * The illustration is a single dimmed speech-bubble glyph, not a paragraph of
		 * explanation: a reader who has joined nothing needs one glanceable signal plus one
		 * sentence, and an empty panel is where a wall of text is least likely to be read.
		 * Both the glyph and the copy still say the same thing in words, so nothing is
		 * carried by the picture alone.
		 */
		function EmptyState() {
			return h(
				"div",
				{ style: S.empty },
				h("span", { style: S.emptyIcon, "aria-hidden": "true" }, icon("chat", 28)),
				h("p", { style: S.emptyTitle }, "还没有加入任何群"),
				h("p", { style: S.emptyBody }, "在会话里让助手用 a2a_group_join 加入一个协作群，或接受别人发来的邀请链接。")
			);
		}

		/** Feed line. */
		function FeedRow(props) {
			const entry = props.entry;
			return h(
				"li",
				{ style: S.feedItem },
				h("span", { style: S.feedWho }, entry.senderName + "："),
				h("span", { style: S.feedText }, previewText(entry.text, 200)),
				entry.time > 0 ? h("span", { style: S.lastTime }, formatTime(entry.time)) : null
			);
		}

		/** One group: collapsed summary row, expanded roster + feed. */
		function GroupCard(props) {
			const group = props.group;
			const open = props.open === true;
			const onToggle = props.onToggle;
			const last = group.lastMessage;

			const head = h(
				"button",
				{
					type: "button",
					style: S.cardHead,
					onClick: onToggle,
					"aria-expanded": open,
					title: group.topic !== "" ? group.name + " · " + group.topic : group.name
				},
				h("span", { style: S.chevron }, icon(open ? "chevronDown" : "chevronRight", 12)),
				h("span", { style: S.groupName }, group.name),
				group.unreadCount > 0
					? h(
						"span",
						{
							style: S.badge,
							// The dot is the count; the word 「未读」 lives in the tooltip, so the
							// row stays readable at a glance without losing the accessible label.
							title: String(group.unreadCount) + " 条未读"
						},
						group.unreadCount > 99 ? "99+" : String(group.unreadCount)
					)
					: null,
				h(
					"span",
					{ style: S.memberCount, title: String(group.memberCount) + " 个成员" },
					icon("users", 12),
					String(group.memberCount)
				)
			);

			const summary =
				last === undefined
					? h("div", { style: S.last }, h("span", { style: S.lastText }, "（还没有消息）"))
					: h(
							"div",
							{ style: S.last },
							h("span", { style: S.lastWho }, last.senderName + "："),
							h("span", { style: S.lastText }, previewText(last.text, 60)),
							last.time > 0 ? h("span", { style: S.lastTime }, formatTime(last.time)) : null
						);

			const detail = open
				? h(
						"div",
						{ style: S.cardBody },
						h(
							"div",
							{ style: S.memberRow },
							h("p", { style: S.sectionLabel }, "成员"),
							group.members.length === 0
								// Not an error: naming the members needs a member credential, and
								// this page is rendered before any Session exists. Say where the
								// answer lives instead of leaving a gap that reads as "nobody here".
								? h("span", { style: S.chip }, "名单需在会话里查看（a2a_group_set_card）")
								: group.members.map((member) =>
										h(
											"span",
											{ key: member.id, style: S.chip, title: member.role === "" ? member.name : member.name + " · " + member.role },
											member.self ? member.name + "（我）" : member.name
										)
									)
						),
						h(
							"div",
							{ style: S.memberRow },
							h("p", { style: S.sectionLabel }, "最近消息"),
							group.feed.length === 0
								? h("span", { style: S.chip }, "（还没有消息）")
								: h("ul", { style: S.feed }, group.feed.map((entry) => h(FeedRow, { key: entry.id, entry: entry })))
						),
						h("p", { style: S.emptyBody }, "只读视图：发消息请在会话里让助手用 a2a_group_post。")
					)
				: null;

			return h("div", { style: S.card }, head, h("div", { style: S.cardBody }, summary), detail);
		}

		/**
		 * Central panel page (registered into the `main` slot under key PANEL_ID).
		 * Receives no props from the shell; all data comes from the Host source.
		 */

		/**
		 * Split groups into the sections the panel draws.
		 *
		 * Order is deliberate and not "by recency": ownership first (it needs action), then
		 * membership (where the work happens), then discovery (a browse), and colleagues last
		 * because a card is reference material rather than a place to be.
		 *
		 * A group with no explicit role is treated as `joined`: that is the safe default,
		 * because showing an owner control for a group somebody merely belongs to would offer
		 * an action the server will refuse.
		 */

		/**
		 * Colleague cards from the snapshot.
		 *
		 * A card is a person's own description aggregated across their groups: name,
		 * headline, tags, and which groups they share with this instance. The Host
		 * assembles it from what members declared, so nothing here invents identity — an
		 * absent card means "not fetched" and the tab says so.
		 */
		function readCards(raw) {
			const list = raw !== null && typeof raw === "object" && !Array.isArray(raw) && Array.isArray(raw.cards)
				? raw.cards
				: [];
			const cards = [];
			for (let i = 0; i < list.length; i += 1) {
				const entry = list[i];
				if (entry === null || typeof entry !== "object") continue;
				const name = pickString(firstDefined(entry, [ "name", "displayName", "title" ]));
				if (name === "") continue;
				cards.push({
					id: pickString(firstDefined(entry, [ "personId", "memberId", "id", "name" ])) || name,
					name: name,
					headline: pickString(firstDefined(entry, [ "headline", "roleAbout", "role", "about" ])),
					tags: (Array.isArray(entry.tags) ? entry.tags : []).filter(function (tag) {
						return typeof tag === "string" && tag !== "";
					}),
					groups: Array.isArray(entry.groups) ? entry.groups : [],
					// Every role they declared, in group order. The card shows the group names
					// beside the roles, so a person who is "研发" in one group and "产品" in
					// another reads as one colleague with two contexts rather than two people.
					roles: (Array.isArray(entry.roles) ? entry.roles : []).filter(function (role) {
						return typeof role === "string" && role !== "";
					}),
					// My own card: the only one the reader can change, so the only one styled as
					// editable. The Host decides this by member id, not by name.
					isSelf: entry.isSelf === true,
					// A cached roster can be an hour old; its timestamp survives, its boolean does not.
					online: presenceOf(entry),
					// Their A2A address, when the host knows one. Editable from the card, and the
					// basis for a future "reach them directly" action.
					endpoint: pickString(firstDefined(entry, [ "endpoint", "baseUrl", "url" ]))
				});
			}
			return cards;
		}

		/**
		 * The Self view the members pane needs: who "I" am, and what I wrote in this group.
		 *
		 * THREE SOURCES, deliberately ranked, because no single one is complete:
		 *
		 *  1. the roster row the Host marked `isSelf` — authoritative for the display name
		 *     and for `roleAbout` IN THIS GROUP;
		 *  2. the person table (`snapshot.cards`) entry with `isSelf` — carries the default
		 *     `headline` and the tags, so a member whose roster row predates the
		 *     `roleAbout` field still shows something rather than an empty line;
		 *  3. the membership row's own display name / personId, when neither list arrived.
		 *
		 * The fallback ORDER matters for exactly one case: after I clear my own about, the
		 * roster carries nothing but the person table still remembers the last headline I
		 * ever declared. Showing it would tell me I still have a description I just deleted.
		 * So a roster that arrived but says nothing about me is taken at its word —
		 * `roleAbout === ""` with `hasSelf === true` means "cleared", not "unknown".
		 *
		 * @param {object|undefined} group - normalized group.
		 * @param {Array} cards - normalized person table.
		 * @returns {{hasSelf: boolean, personId: string, name: string, about: string, aboutFrom: string, online: boolean, tags: string[]}}
		 *   `aboutFrom` is "group" | "person" | "none", which the pane uses to tell a
		 *   cleared description from an unset one.
		 */
		function pickSelf(group, cards) {
			const result = {
				hasSelf: false,
				personId: "",
				name: "",
				about: "",
				aboutFrom: "none",
				online: false,
				tags: []
			};

			const roster = group !== undefined && Array.isArray(group.members) ? group.members : [];
			// Identity is matched by person id, never by display name: two members of one
			// group may both be called 我 (or a display name may be edited to match someone
			// else's), and the wrong match would offer an edit of the wrong profile.
			const ownId = group !== undefined ? pickString(group.personId) : "";
			let own = roster.filter(function (member) {
				return member.self === true;
			})[0];
			if (own === undefined && ownId !== "") {
				own = roster.filter(function (member) {
					return member.id === ownId;
				})[0];
			}

			const selfCard = (Array.isArray(cards) ? cards : []).filter(function (card) {
				return card.isSelf === true;
			})[0];

			// Last identity resort, for a Host that ships neither `group.personId` nor a
			// `self` marker on the roster but does mark its own card: match the roster row
			// against the card's person id. Still id-based, so it cannot pick the wrong
			// person the way a name match would.
			if (own === undefined && selfCard !== undefined && selfCard.id !== "") {
				own = roster.filter(function (member) {
					return member.id === selfCard.id;
				})[0];
			}

			if (own !== undefined) {
				result.hasSelf = true;
				result.personId = own.id;
				result.name = own.name;
				result.online = own.online;
				result.tags = own.tags;
				if (own.roleAbout !== "") {
					result.about = own.roleAbout;
					result.aboutFrom = "group";
				} else if (own.roleAboutKnown !== true && selfCard !== undefined && selfCard.headline !== "") {
					// The roster row has no about field at all — it predates `roleAbout`, or
					// this Host sends it only in the table. The table is the documented default.
					result.about = selfCard.headline;
					result.aboutFrom = "person";
				}
				// `roleAboutKnown === true` with an empty value means I cleared it. Leaving
				// `about` empty is the point: backfilling the old headline would tell me the
				// clear had failed.
				if (result.name === "" && selfCard !== undefined) result.name = selfCard.name;
				return result;
			}

			if (selfCard !== undefined) {
				result.hasSelf = true;
				result.personId = selfCard.id;
				result.name = selfCard.name;
				result.about = selfCard.headline;
				result.aboutFrom = selfCard.headline === "" ? "none" : "person";
				result.online = selfCard.online;
				result.tags = selfCard.tags;
				return result;
			}

			// No roster and no table: the membership row still knows who I am, which is
			// enough to draw the row and to name the group in the edit instruction.
			if (group !== undefined && ownId !== "") {
				result.hasSelf = true;
				result.personId = ownId;
				result.name = ownId;
			}
			return result;
		}

		/**
		 * Split a roster into the row order the pane renders.
		 *
		 * ## The order, and why
		 *
		 *   1. 「所有人」 — added by the pane, not part of this function: it is an address, not
		 *      a person, and it is always first regardless of who is in the group.
		 *   2. 群主      — the person who can approve and invite. In a collaboration group the
		 *      owner is the one you address when something is stuck, so they outrank everyone.
		 *   3. 我        — where am I, and the only row with a second action (edit).
		 *   4. everyone else — online first, then by name.
		 *
		 * Alphabetical order is right only for strangers. In a group you share with eight
		 * people, "who runs this", "where am I" and "who is around" are the questions that
		 * actually get asked.
		 *
		 * ## When I am the owner
		 *
		 * `mine` and `owner` are then the SAME person, and rendering both would show me twice
		 * in a list whose whole purpose is telling me who is here. The row is returned once,
		 * in `owner`, flagged `isSelf` so the pane can label it 「群主 · 我」 and keep the edit
		 * action. When the owner is somebody else, `mine` is me and `owner` is them.
		 *
		 * A group whose owner is not in the roster yields `owner: undefined` — an empty slot
		 * at position 2 would read as a missing person rather than as absent data.
		 *
		 * @param {Array} members - normalized roster.
		 * @param {object} self - output of {@link pickSelf}.
		 * @returns {{owner: object|undefined, mine: object|undefined, others: Array}}
		 *   `owner` carries `isSelf` when I run this group. Never returns the same person twice.
		 */

		/**
		 * The instruction that invites one colleague into THIS group.
		 *
		 * Both facts are known here — the group from the pane, the person from the pick — so the
		 * sentence needs no choice from the reader. That is the whole reason the action lives on the
		 * group rather than on the card: an invitation whose subject is ambiguous must not be offered.
		 *
		 * Named by id, not by name: two members of one group can share a display name.
		 *
		 * @param {object} group - the group whose pane this is.
		 * @param {object} person - the colleague to invite.
		 * @returns {string} the text to insert.
		 */
		function draftGroupInvite(group, person) {
			const who = (person.name ?? "") === "" ? person.id : person.name;
			return "用 a2a_person_send 邀请 " + who + "（personId: " + person.id + "）加入「"
				+ (group.name ?? group.id) + "」（groupId: " + group.id + "）。"
				+ "\n（发送后会告诉你对方是否在线；此时在线则立刻送到。）";
		}
		function splitRoster(members, self) {
			const list = Array.isArray(members) ? members : [];
			const mineId = self !== undefined && self.hasSelf === true ? self.personId : "";
			const byDefault = function (left, right) {
				if (left.online !== right.online) return left.online ? -1 : 1;
				return left.name.localeCompare(right.name, "zh-Hans-CN");
			};

			let owner;
			let mine;
			const others = [];

			for (const member of list) {
				const isSelf = member.self === true || (mineId !== "" && member.id === mineId);
				const isOwner = member.role === "owner";
				if (isOwner && owner === undefined) {
					// One row only, even when the owner is me. `isSelf` here is what makes the
					// pane label it 「群主 · 我」 instead of showing a second row below.
					owner = Object.assign({}, member, { isSelf: isSelf || member.self === true });
					continue;
				}
				if (isSelf && mine === undefined) {
					// `isSelf` is the flag the row builder keys its behaviour and badges off.
					// Without it the row would render as an ordinary member and I would lose the
					// only edit affordance in the pane.
					mine = Object.assign({}, member, { isSelf: true });
					continue;
				}
				others.push(member);
			}

			others.sort(byDefault);
			return { owner: owner, mine: mine, others: others };
		}

		function groupByRelationship(groups) {
			const mine = [];
			const joined = [];
			const discover = [];
			for (const group of groups) {
				if (group.discovered === true) {
					discover.push(group);
				} else if (group.role === "owner") {
					mine.push(group);
				} else {
					joined.push(group);
				}
			}
			// Most recently active first inside each section: a directory sorted by name is
			// useless when what you want is "what is happening".
			const byActivity = (left, right) => (right.lastTime || 0) - (left.lastTime || 0);
			mine.sort(byActivity);
			joined.sort(byActivity);
			discover.sort(byActivity);
			return { mine: mine, joined: joined, discover: discover };
		}


		/**
		 * The panel's horizontal tab bar.
		 *
		 * Counts are shown on each tab because "我管理 (0)" is information: it says the
		 * question is answerable, and the answer is none. A tab that vanished when empty
		 * would leave a person wondering whether the feature existed.
		 */
		function TabBar(props) {
			return h(
				"div",
				{
					style: {
						display: "flex",
						gap: "2px",
						borderBottom: "1px solid rgba(128, 128, 128, 0.35)",
						paddingBottom: "0"
					}
				},
				props.tabs.map(function (tab) {
					const active = props.active === tab.id;
					return h(
						"button",
						{
							key: tab.id,
							type: "button",
							title: tab.label,
							style: {
								display: "inline-flex",
								alignItems: "center",
								gap: "4px",
								padding: "6px 8px",
								border: "none",
								borderBottom: active
									? "2px solid currentColor"
									: "2px solid transparent",
								background: "transparent",
								color: "inherit",
								font: "inherit",
								fontSize: "12px",
								fontWeight: active ? 600 : 400,
								opacity: active ? 1 : 0.65,
								cursor: "pointer",
								whiteSpace: "nowrap"
							},
							onClick: function () {
								props.onSelect(tab.id);
							}
						},
						// Decorative glyph, then the word: the icon speeds up scanning, the
						// label keeps the tab answerable without hovering.
						tab.icon === undefined ? null : icon(tab.icon, 12),
						tab.label,
						tab.count === undefined
							? null
							: h("span", { style: { opacity: active ? 0.75 : 0.55, marginLeft: "1px" } }, String(tab.count))
					);
				})
			);
		}

		/**
		 * One colleague's card, in the roster style rather than the group-card style.
		 *
		 * A card answers "who is this and what do they do", so it leads with the name and
		 * the tags rather than with an unread count. Tags are clickable: filtering the
		 * roster by "测试" is the whole point of having tags at all.
		 */

		/**
		 * The instruction that edits a profile, prefilled with the current values.
		 *
		 * Written as a sentence a person would say, because that is what the Session turn will
		 * read: a JSON blob would work but would be something to get wrong rather than something
		 * to edit.
		 *
		 * @param {object} card - the person's card.
		 * @param {string} groupName - which group to act in (the tool needs one for the credential).
		 * @returns {string} the text to insert.
		 */
		function draftProfileEdit(card, groupName) {
			const tags = (card.tags ?? []).join("、");
			const lines = [
				"帮我更新我在「" + (groupName === "" ? "这个群" : groupName) + "」的名片信息："
			];
			if ((card.headline ?? "") !== "") lines.push("简介：" + card.headline);
			if (tags !== "") lines.push("标签：" + tags);
			if ((card.endpoint ?? "") !== "") lines.push("A2A 地址：" + card.endpoint);
			// The last line is the actual ask: the reader edits the values above it and sends.
			lines.push("");
			lines.push("（改上面的内容后直接发送即可；留空的项会被清空。）");
			return lines.join("\n") + " ";
		}

		/**
		 * The instruction that edits MY role in ONE group — the members pane's edit action.
		 *
		 * ## Why an instruction and not a save button
		 *
		 * The browser bundle holds no membership credential. `a2a_group_set_card` authenticates
		 * with `{personId, personKey}`, and that key lives in `memberships.json` on the Host
		 * (0600) and is never published into the page — `lib/index.js` publishes only the
		 * read-only snapshot. A form that POSTed from here would have to either carry the
		 * key into the DOM or invent a second write channel to the Host; both are worse than
		 * the thing they replace. One write path (the Session turn, which already holds the
		 * credential) is also why the panel and the assistant cannot disagree about what
		 * was written.
		 *
		 * So the click writes a prefilled instruction into the composer. The reader edits
		 * the sentence and presses Enter; the assistant calls `a2a_group_set_card` with the
		 * values that are now visible in the draft. History, validation and error reporting
		 * are the turn's, which means the failure message ("about is too long") appears in
		 * the conversation next to the thing that caused it rather than in a toast that
		 * cannot say what to do about it.
		 *
		 * `groupId` is included because the tool requires it and the name alone is ambiguous
		 * — two groups may share a display name, and the assistant must not have to guess.
		 * Both are stated as facts the reader can check, not as a JSON payload: an editable
		 * sentence is something a person can correct, and a payload is something to get wrong.
		 *
		 * @param {object} input
		 * @param {string} input.groupName - display name, for the sentence.
		 * @param {string} input.groupId - the tool's required key.
		 * @param {string} [input.about] - current text, prefilled so a small edit stays small.
		 * @param {string[]} [input.tags] - current tags.
		 * @returns {string} text to insert into the composer.
		 */
		/**
		 * Write a profile through the Host, over DSH's Connection RPC.
		 *
		 * Lazy and cached: the module is resolved on first save rather than at render, so a host without
		 * the Connection plugin shows "saving is unavailable" instead of breaking the pane.
		 *
		 * @returns {object|undefined} the RPC client, or undefined when unavailable.
		 */
		/**
		 * Caller into the Host, installed once by apply().
		 *
		 * The browser half of Connection publishes `ctx.connection.rpc`, and that is the same service object
		 * the Host half registers channels on. Handing the call function down as a prop keeps this file free of
		 * any service lookup at render time, which is where a pane must not throw.
		 *
		 * @type {((channel: string, endpoint: string, payload: unknown) => Promise<object>)|undefined}
		 */
		let panelRpcCaller;

		/** Why the caller is unavailable, for the self-check to show instead of a silent failure. */
		let panelRpcError = "";

		/**
		 * Install the Connection caller from the plugin's context.
		 *
		 * Called from apply(), where the service exists. Records the reason when it does not, because a panel
		 * that says "unavailable" without saying why costs a debugging session per occurrence.
		 *
		 * @param {object} ctx - plugin context.
		 */
		function installPanelRpc(ctx) {
			try {
				const connection = ctx !== null && ctx !== undefined && typeof ctx.get === "function"
					? ctx.get("connection")
					: undefined;
				if (connection !== undefined && connection !== null && connection.rpc !== undefined
					&& typeof connection.rpc.call === "function") {
					panelRpcCaller = function (channel, endpoint, payload) {
						return connection.rpc.call(channel, endpoint, payload);
					};
					panelRpcError = "";
					return;
				}
				panelRpcError = "connection service has no rpc.call";
			} catch (error) {
				panelRpcError = String((error && error.message) || error);
			}
		}

		/**
		 * Save one profile field through the Host.
		 *
		 * Resolves to `{ ok, message }` rather than throwing: the caller is a button handler, and a
		 * rejected promise there would surface as silence.
		 *
		 * @param {object} input - `{ groupId, sessionId, about?, tags?, headline? }`.
		 * @returns {Promise<{ok: boolean, message: string}>} the outcome, phrased for a person.
		 */
		async function saveProfile(input) {
			if (panelRpcCaller === undefined) {
				return { ok: false, message: "面板写入通道不可用（" + (panelRpcError === "" ? "未安装" : panelRpcError) + "）" };
			}
			try {
				const result = await panelRpcCaller("/a2a-panel", "profile", input);
				if (result !== null && result !== undefined && result.ok === true) {
					return { ok: true, message: "已保存" };
				}
				const code = result && result.error ? result.error.code : "unknown";
				return { ok: false, message: "保存失败：" + code };
			} catch (error) {
				return { ok: false, message: "保存失败：" + String((error && error.message) || error) };
			}
		}

		/**
		 * Call the Host's `ping` endpoint and report what came back.
		 *
		 * Uses the same client as `saveProfile`, on purpose: a probe that takes a different path proves
		 * nothing about the path the feature will use.
		 *
		 * @returns {Promise<string>} a line to show in the pane.
		 */
		async function panelSelfCheck() {
			if (panelRpcCaller === undefined) {
				return "面板通道不可用：" + (panelRpcError === "" ? "未安装" : panelRpcError);
			}
			try {
				const result = await panelRpcCaller("/a2a-panel", "ping", { at: Date.now() });
				if (result !== null && result !== undefined && result.ok === true) {
					const value = result.value ?? {};
					return "面板通道正常（" + String(value.at ?? "?") + "）";
				}
				return "面板通道返回失败：" + String(result && result.error ? result.error.code : "?");
			} catch (error) {
				return "面板通道异常：" + String((error && error.message) || error);
			}
		}

		/**
		 * Inline editor for my group role: a description and tags, saved in place.
		 *
		 * Two fields rather than one, because they answer different questions — "what do I do here" and
		 * "what should people search for to find me" — and the Host stores them separately.
		 *
		 * @param {object} props - `{ groupId, sessionId, about, tags, onDone, onCancel }`.
		 * @returns {object} the editor.
		 */
		function RoleEditor(props) {
			// The display name is how this member appears in the group's roster and on every colleague card. It is
			// the field a person edits when their name shows as a long id (a session id) instead of a name.
			const [displayName, setDisplayName] = react.useState(props.displayName ?? "");
			const [about, setAbout] = react.useState(props.about ?? "");
			const [tags, setTags] = react.useState((props.tags ?? []).join("、"));
			// The person-level headline. Different scope from `about`: that one is this membership, this one
			// follows the person into every group and onto every colleague card.
			const [headline, setHeadline] = react.useState(props.headline ?? "");
			const [state, setState] = react.useState("idle");
			const [message, setMessage] = react.useState("");

			/** Save both fields; report the outcome inline rather than in an alert. */
			function save() {
				setState("saving");
				setMessage("");
				// Tags are typed as a separated list because that is how a person thinks of them; the Host
				// stores an array.
				const parsed = String(tags ?? "")
					.split(/[、,，\s]+/u)
					.map((tag) => tag.trim())
					.filter((tag) => tag !== "");
				saveProfile({
					groupId: props.groupId,
					sessionId: props.sessionId,
					// Omitted when untouched rather than sent empty: an absent field means "leave it alone".
					displayName: String(displayName ?? "").trim() === String(props.displayName ?? "").trim()
						? undefined
						: String(displayName ?? "").trim(),
					about: String(about ?? "").trim(),
					tags: parsed,
					// Omitted when untouched rather than sent empty: an absent field means "leave it alone",
					// and a cleared one would wipe the person's headline on every role edit.
					headline: String(headline ?? "").trim() === String(props.headline ?? "").trim()
						? undefined
						: String(headline ?? "").trim(),
				}).then(function (result) {
					setState(result.ok ? "done" : "failed");
					setMessage(result.message);
					if (result.ok && typeof props.onSaved === "function") props.onSaved();
				});
			}

			return h(
				"div",
				{ style: membersLayout.editorBox },
				// Scope stated in the label, not only in a placeholder: editing the wrong one produces a
				// change that does not show up where the reader expects, and the difference is invisible in a
				// screenshot.
				h("span", { style: { fontSize: "10px", opacity: 0.6 } }, "昵称（群名单和同事名片里显示的名字）"),
				h("input", {
					type: "text",
					value: displayName,
					placeholder: "例如：小 D",
					onChange: function (event) {
						setDisplayName(event !== null && event !== undefined && event.target !== undefined ? event.target.value : "");
					},
					style: membersLayout.editorInput
				}),
				h("span", { style: { fontSize: "10px", opacity: 0.6 } }, "个人介绍（所有群共用，显示在同事名片上）"),
				h("input", {
					type: "text",
					value: headline,
					placeholder: "我是谁，例如：后端工程师，专注对账系统",
					onChange: function (event) {
						setHeadline(event !== null && event !== undefined && event.target !== undefined ? event.target.value : "");
					},
					style: membersLayout.editorInput
				}),
				h("span", { style: { fontSize: "10px", opacity: 0.6 } }, "群内介绍（只在这个群生效）"),
				h("input", {
					type: "text",
					value: about,
					placeholder: "我在这个群负责什么，例如：负责对账与发票生成",
					onChange: function (event) {
						setAbout(event !== null && event !== undefined && event.target !== undefined ? event.target.value : "");
					},
					style: membersLayout.editorInput
				}),
				h("input", {
					type: "text",
					value: tags,
					placeholder: "标签，用顿号或逗号分隔，例如：研发、后端",
					onChange: function (event) {
						setTags(event !== null && event !== undefined && event.target !== undefined ? event.target.value : "");
					},
					style: membersLayout.editorInput
				}),
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
					h(
						"button",
						{
							type: "button",
							disabled: state === "saving",
							title: "保存到群宿主，立即对所有成员生效",
							style: Object.assign({}, membersLayout.editorSave, state === "saving" ? { opacity: 0.5 } : {}),
							onClick: save
						},
						state === "saving" ? "保存中…" : "保存"
					),
					h(
						"button",
						{
							type: "button",
							title: "放弃修改",
							style: membersLayout.editorCancel,
							onClick: function () { if (typeof props.onCancel === "function") props.onCancel(); }
						},
						"取消"
					),
					message === ""
						? null
						: h(
								"span",
								{ style: { fontSize: "10px", opacity: 0.75, color: state === "failed" ? "#c0392b" : "inherit" } },
								message
							)
				)
			);
		}

		function draftGroupRoleEdit(input) {
			const given = input === null || input === undefined ? {} : input;
			const groupName = pickString(given.groupName);
			const groupId = pickString(given.groupId);
			const about = pickString(given.about);
			const tags = (Array.isArray(given.tags) ? given.tags : []).filter(function (tag) {
				return typeof tag === "string" && tag !== "";
			}).join("、");

			const lines = [
				"用 a2a_group_set_card 更新我在「" + (groupName === "" ? "这个群" : groupName) + "」的群内介绍" + (groupId === "" ? "" : "（groupId: " + groupId + "）") + "："
			];
			lines.push("about：" + about);
			if (tags !== "") lines.push("tags：" + tags);
			lines.push("");
			lines.push("（改上面的内容后直接发送即可。about 是一句话、最多 120 字；清空 about 就是删掉这条介绍。）");
			return lines.join("\n") + " ";
		}

		/**
		 * The instruction that removes MY role in one group.
		 *
		 * Separate from {@link draftGroupRoleEdit} because "clear" is the one edit a reader
		 * cannot express by editing text in place: deleting the line `about：` reads as
		 * "leave it alone" to a careful reader (the tool leaves a field unchanged when it is
		 * omitted), so the intent has to be stated rather than implied.
		 *
		 * @param {{groupName?: string, groupId?: string}} input
		 * @returns {string} text to insert into the composer.
		 */
		function draftGroupRoleClear(input) {
			const given = input === null || input === undefined ? {} : input;
			const groupName = pickString(given.groupName);
			const groupId = pickString(given.groupId);
			return "用 a2a_group_set_card 把我在「" + (groupName === "" ? "这个群" : groupName) + "」的群内介绍清空"
				+ (groupId === "" ? "" : "（groupId: " + groupId + "）")
				+ "：about 传空字符串，tags 传空数组。发送即可。";
		}

		function ColleagueCard(props) {
			const card = props.card;
			return h(
				"div",
				{
					style: {
						display: "flex",
						flexDirection: "column",
						gap: "3px",
						padding: "8px 10px",
						// Mine is outlined: the list is otherwise read-only, and the one card the
						// reader owns should not look like the ones they cannot touch.
						border: card.isSelf === true
							? "1px solid currentColor"
							: "1px solid rgba(128, 128, 128, 0.35)",
						borderRadius: "6px"
					}
				},
				h(
					"div",
					{ style: { display: "flex", alignItems: "baseline", gap: "6px" } },
					h("span", { style: { fontWeight: 600, fontSize: "13px" } }, card.name),
					card.isSelf === true
						? h(
								"span",
								{
									style: {
										padding: "0 5px",
										borderRadius: "3px",
										fontSize: "10px",
										// Same inverted-chip pair as membersLayout.selfTag; currentColor here produced a
										// near-white pill with white text in a dark theme. See the note there.
										background: "light-dark(#1a1a1a, #f2f2f2)",
										color: "light-dark(#f2f2f2, #1a1a1a)"
									},
									title: "这是你自己的名片，只有你能改"
								},
								"我"
							)
						: null,
					card.headline !== ""
						? h("span", { style: { fontSize: "11px", opacity: 0.7 } }, card.headline)
						: null
				),
				card.tags.length === 0
					? null
					: h(
							"div",
							{ style: { display: "flex", flexWrap: "wrap", gap: "3px" } },
							card.tags.map(function (tag) {
								return h(
									"button",
									{
										key: tag,
										type: "button",
										title: "只看标签「" + tag + "」的同事",
										style: {
											padding: "1px 7px",
											border: "1px solid rgba(128, 128, 128, 0.5)",
											borderRadius: "999px",
											background: "transparent",
											color: "inherit",
											font: "inherit",
											fontSize: "11px",
											cursor: "pointer",
											opacity: 0.85
										},
										onClick: function () {
											props.onPickTag(tag);
										}
									},
									tag
								);
							})
						),
				// Where to find them, by name. The group COUNT used to live here, which told the
				// reader nothing: they are looking at the card from inside a group they already
				// share, so the number restates the premise. Names answer the real question —
				// which context to approach this person in.
				// Status, then context. The dot alone is decoration — "在线" has to be legible at a
				// glance, because its whole job is to answer "will they see this now".
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap" } },
					h("span", {
						style: {
							width: "6px",
							height: "6px",
							borderRadius: "50%",
							flex: "0 0 auto",
								// Three states, not two. `undefined` means we hold no timestamp for this member — the roster
								// predates timestamp caching, or the host does not track presence. Rendering that as
								// "不在线" asserts something we do not know, which is how a 84-minute-old cache kept
								// claiming a live member was away.
								background: card.online === true
									? "#3fb950"
									: card.online === false
										? "rgba(128, 128, 128, 0.5)"
										: "rgba(128, 128, 128, 0.28)",
							},
							"aria-hidden": "true"
						}),
						h(
							"span",
							{
								style: {
									fontSize: "11px",
									opacity: card.online === undefined ? 0.45 : 0.8,
									color: card.online === true ? "#3fb950" : "inherit"
								},
								title: card.online === true
									? "对方正开着 DSH，发消息会立即送到"
									: card.online === false
										? "对方当前不在线，消息会存着等他上线"
										: "还没有这个人的在线信息。在会话里查一次群成员即可刷新。"
							},
							card.online === true ? "在线" : card.online === false ? "不在线" : "状态未知"
						),
					card.groups.length === 0
						? null
						: h(
								"span",
								{ style: { fontSize: "11px", opacity: 0.6 } },
								"· " + card.groups.slice(0, 3).join("、")
									+ (card.groups.length > 3 ? " 等 " + String(card.groups.length) + " 个群" : "")
							)
				),
				// The edit affordance. The panel cannot write a profile itself — it renders before
				// any Session exists and holds no member credential — so it does the part it CAN
				// do: put a prefilled instruction in the composer, so editing is "change the words
				// and press enter" rather than "know the incantation".
				card.isSelf === true
					? h(
							"div",
							{ style: { display: "flex", alignItems: "center", gap: "6px", marginTop: "2px" } },
							h(
								"button",
								{
									type: "button",
									title: "把编辑指令填进输入框，改完发送即可",
									style: {
										padding: "2px 8px",
										border: "1px solid currentColor",
										borderRadius: "4px",
										background: "transparent",
										color: "inherit",
										font: "inherit",
										fontSize: "11px",
										cursor: "pointer"
									},
									onClick: function () {
										// Replace rather than append: the draft is being replaced with an
										// instruction, and appending to whatever was typed would produce a
										// sentence nobody wrote.
										const text = draftProfileEdit(card, props.groupName ?? "");
										const actions = props.inputActions;
										if (actions !== null && actions !== undefined
											&& typeof actions.setDraft === "function") {
											actions.setDraft(text);
										} else if (actions !== null && actions !== undefined
											&& typeof actions.captureInsertion === "function"
											&& typeof actions.insertText === "function") {
											actions.insertText(text, actions.captureInsertion());
										}
									}
								},
								"改我的名片"
							),
							h("span", { style: { fontSize: "10px", opacity: 0.5 } }, "点一下把指令填进输入框")
						)
					: null
			);
		}

		/** A tag chip row: "all" plus every tag present in the roster. */
		function TagFilter(props) {
			return h(
				"div",
				{ style: { display: "flex", flexWrap: "wrap", gap: "4px" } },
				[ "全部" ].concat(props.tags).map(function (tag, index) {
					const value = index === 0 ? "" : tag;
					const active = props.active === value;
					return h(
						"button",
						{
							key: tag,
							type: "button",
							style: {
								padding: "2px 8px",
								border: "1px solid rgba(128, 128, 128, 0.5)",
								borderRadius: "999px",
								background: active ? "light-dark(#1a1a1a, #f2f2f2)" : "transparent",
								color: active ? "light-dark(#f2f2f2, #1a1a1a)" : "inherit",
								font: "inherit",
								fontSize: "11px",
								cursor: "pointer"
							},
							onClick: function () {
								props.onSelect(value);
							}
						},
						tag
					);
				})
			);
		}

		/**
		 * One titled section of the panel.
		 *
		 * Rendered only when non-empty. `hint` carries the one line that explains why the
		 * section exists ("你是群主" / "还没加入"), because a heading alone leaves a person
		 * guessing why two groups with the same shape sit in different places.
		 */
		function GroupSection(props) {
			if (props.groups.length === 0) return null;
			return h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "6px" } },
				h(
					"div",
					{ style: { display: "flex", alignItems: "baseline", gap: "8px" } },
					h("p", { style: S.sectionLabel }, props.title),
					h("span", { style: S.hint }, String(props.groups.length)),
					props.hint ? h("span", { style: S.hint }, props.hint) : null
				),
				props.groups.map((group) =>
					h(GroupCard, {
						key: group.id,
						group: group,
						open: props.expanded[group.id] === true,
						onToggle: () => {
							props.onToggle(group.id);
						}
					})
				)
			);
		}




		/**
		 * Layout for the right-column members pane.
		 *
		 * ## Why nothing here sets `maxWidth`
		 *
		 * The right column is user-resizable. An earlier version bounded the pane at 300px,
		 * which is correct at the default width and wrong everywhere else: widen the column
		 * and the roster stays pinned to the left of an ever-larger empty gutter. A pane that
		 * fills its column is correct at every width, so the constraint moves from the
		 * container to the *text*: each row is `flex` with `minWidth: 0`, so a name takes the
		 * space its column has and ellipsizes only when that space genuinely runs out.
		 *
		 * ## Why `height` is absent, and why every column child is `flex: 0 0 auto`
		 *
		 * Two independent faults pushed the roster to the bottom of a mostly empty column:
		 *
		 *  1. `height: 100%` resolved against a parent whose height is not definite (the tab
		 *     seat between the slot owner and this pane has no fixed height), so the pane
		 *     became taller than its content and left the slack at the bottom;
		 *  2. `groupName` carried `flex: 1 1 auto`, written when it was meant to stretch in a
		 *     ROW. As a direct child of this column container, `flex-grow` applies to the
		 *     BLOCK axis, so the group name inflated and pushed everything below it down.
		 *
		 * The fix is the layout itself, not a tuned height: the pane sizes to its content
		 * (`height: auto`) and every direct child is `flex: 0 0 auto`, so no child can grow
		 * and swallow the slack. Scrolling is the parent's job — one scroll container in the
		 * chain, at the level that actually knows its height.
		 */
// Button geometry, shared by every control in this pane.
//
// Declared OUTSIDE membersLayout on purpose: spreading it from inside that object literal reads it before it is
// initialised, which throws 「Cannot access 'membersLayout' before initialization」 and blanks the whole bundle.
const buttonBase = {
	display: "inline-flex",
	alignItems: "center",
	gap: "5px",
	padding: "3px 10px",
	borderRadius: "4px",
	background: "transparent",
	color: "inherit",
	font: "inherit",
	fontSize: "11px",
	lineHeight: "1.5",
	cursor: "pointer"
};
const buttonOutline = { border: "1px solid rgba(128, 128, 128, 0.45)" };
const buttonDashed = { border: "1px dashed rgba(128, 128, 128, 0.5)" };

		const membersLayout = {
			// Button geometry, in one place. Every control in this pane takes its size from here so that
			// "button" looks the same wherever it appears; only the semantic differences (dashed vs solid border)
			// stay per-button.
			// The border treatment, split out because two buttons need a different one for a reason.

			// The inline role editor: a box that appears under my row, in the roster's own visual language so
			// it reads as part of that row rather than as a separate screen.
			editorBox: {
				display: "flex",
				flexDirection: "column",
				gap: "5px",
				margin: "4px 0 6px",
				padding: "8px",
				border: "1px solid rgba(128, 128, 128, 0.4)",
				borderRadius: "6px",
				background: "transparent"
			},
			editorInput: {
				width: "100%",
				boxSizing: "border-box",
				padding: "4px 7px",
				border: "1px solid rgba(128, 128, 128, 0.35)",
				borderRadius: "4px",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: "11px",
				colorScheme: "light dark"
			},
			// Solid border and full-strength text: the one action that commits, distinguished by contrast
			// rather than by a colour that would only work on one theme.
			editorSave: {
				padding: "3px 12px",
				border: "1px solid currentColor",
				borderRadius: "4px",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: "11px",
				fontWeight: 600,
				cursor: "pointer"
			},
			editorCancel: {
				padding: "3px 10px",
				border: "1px solid rgba(128, 128, 128, 0.4)",
				borderRadius: "4px",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: "11px",
				opacity: 0.75,
				cursor: "pointer"
			},

			// A fixed overlay: the pane clips its own overflow, so a dialog parented inside it would be cut
			// off at the pane's edge and the search box would appear to be missing.
			dialogOverlay: {
				position: "fixed",
				inset: "0",
				// Translucent black works on both themes: it darkens without asserting a palette.
				background: "rgba(0, 0, 0, 0.35)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				zIndex: 9999
			},
			dialogPanel: {
				display: "flex",
				flexDirection: "column",
				gap: "8px",
				width: "min(420px, calc(100vw - 32px))",
				maxHeight: "min(460px, calc(100vh - 64px))",
				padding: "14px",
				// `Canvas` is the system colour for a window surface: it resolves to white on a light theme
				// and near-black on a dark one without this file knowing which is active. The previous
				// version guessed a dark hex behind a variable that does not exist, so on a light theme it
				// drew dark grey on black.
				background: "Canvas",
				color: "CanvasText",
				// Two borders: a hairline for shape, and a soft one for separation on themes where the panel
				// colour and the page colour are nearly the same.
				border: "1px solid rgba(128, 128, 128, 0.35)",
				borderRadius: "8px",
				boxShadow: "0 12px 32px rgba(0, 0, 0, 0.28)",
				boxSizing: "border-box",
				overflow: "hidden",
				// Tells the browser to render form controls and scrollbars for whichever theme is active.
				colorScheme: "light dark"
			},
			dialogHeader: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: "8px"
			},
			dialogClose: {
				padding: "0 4px",
				border: "none",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: "14px",
				lineHeight: 1,
				cursor: "pointer",
				opacity: 0.6
			},
			dialogSearch: {
				width: "100%",
				boxSizing: "border-box",
				padding: "6px 8px",
				border: "1px solid rgba(128, 128, 128, 0.4)",
				borderRadius: "5px",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: "12px",
				// Without this the placeholder uses a browser default that ignores the theme.
				colorScheme: "light dark"
			},
			// Scrolls on its own: the header and the search stay put while the list moves, which is what
			// makes a long result set usable in a short dialog.
			dialogList: {
				display: "flex",
				flexDirection: "column",
				gap: "2px",
				overflowY: "auto",
				minHeight: 0
			},
			dialogItem: {
				display: "flex",
				alignItems: "baseline",
				gap: "8px",
				width: "100%",
				padding: "6px 8px",
				border: "1px solid transparent",
				borderRadius: "5px",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				textAlign: "left",
				cursor: "pointer"
			},
			// The pane's single, quiet entry point into the dialog.
			inviteButton: {
				...buttonBase,
				alignSelf: "flex-start",
				// Dashed, deliberately: this control CREATES a link rather than acting on existing data, and that
				// distinction is one of the few border treatments worth keeping.
				...buttonDashed
			},

			// The unbound pane: an explainer with one action, not a wall of text. Generous line-height
			// because the copy is read once, carefully, by somebody who does not yet know what a
			// collaboration group is.
			unboundBody: {
				display: "flex",
				flexDirection: "column",
				gap: "6px",
				paddingTop: "2px"
			},
			unboundLead: {
				margin: 0,
				fontSize: "12px",
				lineHeight: 1.65,
				opacity: 0.78
			},
			// Step headings are numbered in the text, so the style only has to make them stand out
			// without implying a required order.
			unboundStep: {
				marginTop: "4px",
				fontSize: "12px",
				fontWeight: 600,
				opacity: 0.9
			},
			unboundHint: {
				margin: 0,
				fontSize: "11px",
				lineHeight: 1.6,
				opacity: 0.62
			},
			unboundInput: {
				width: "100%",
				boxSizing: "border-box",
				padding: "5px 7px",
				border: "1px solid rgba(128, 128, 128, 0.35)",
				borderRadius: "4px",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: "11px",
				resize: "vertical"
			},
			unboundButton: {
				...buttonBase,
				alignSelf: "flex-start",
				...buttonOutline
			},
			// Dimmed rather than hidden while the box is empty: a button that disappears teaches the
			// reader nothing about why.
			unboundButtonOff: {
				opacity: 0.4,
				cursor: "default",
				borderColor: "rgba(128, 128, 128, 0.5)"
			},
			unboundFootnote: {
				marginTop: "6px",
				paddingTop: "6px",
				borderTop: "1px solid rgba(128, 128, 128, 0.35)",
				fontSize: "10px",
				lineHeight: 1.6,
				opacity: 0.5
			},

			// The invite area sits below the roster, separated by a rule so it does not read as another
			// member row — an invitee is not in the group yet.
			inviteBlock: {
				display: "flex",
				flexDirection: "column",
				gap: "4px",
				marginTop: "6px",
				paddingTop: "6px",
				borderTop: "1px solid rgba(128, 128, 128, 0.35)"
			},
			// Human-confirmation settings. Same border-and-gap language as `inviteBlock`, because they are the same
			// kind of thing: a section under the roster, not a new surface.
			confirmBlock: {
				display: "flex",
				flexDirection: "column",
				gap: "6px",
				marginTop: "8px",
				paddingTop: "8px",
				borderTop: "1px solid rgba(128, 128, 128, 0.35)"
			},
			confirmTitle: {
				fontSize: "12px",
				fontWeight: 600
			},
			confirmRow: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: "8px",
				fontSize: "11px"
			},
			confirmLabel: {
				opacity: 0.75
			},
			confirmSelect: {
				fontSize: "11px",
				padding: "2px 4px",
				borderRadius: "4px",
				border: "1px solid rgba(128, 128, 128, 0.45)",
				background: "transparent",
				color: "inherit"
			},
			confirmNumber: {
				width: "64px",
				fontSize: "11px",
				padding: "2px 4px",
				borderRadius: "4px",
				border: "1px solid rgba(128, 128, 128, 0.45)",
				background: "transparent",
				color: "inherit"
			},
			// Inheriting means the profile decides. Dimmed rather than hidden, so the reader can still see what the
			// profile value is.
			confirmDisabled: {
				opacity: 0.45
			},
			confirmWarn: {
				fontSize: "11px",
				lineHeight: 1.45,
				padding: "5px 7px",
				borderRadius: "4px",
				background: "light-dark(#fff4e5, #3a2b17)",
				color: "light-dark(#7a4b00, #f0c583)"
			},
			muted: {
				fontSize: "11px",
				opacity: 0.6,
				lineHeight: 1.45
			},
			inviteLabel: {
				fontSize: "11px",
				opacity: 0.6
			},
			// A chip rather than a button: several colleagues may be listed, and a row of full-width
			// buttons would push the roster off the panel.
			inviteChip: {
				padding: "2px 8px",
				border: "1px dashed rgba(128, 128, 128, 0.5)",
				borderRadius: "999px",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: "11px",
				cursor: "pointer",
				maxWidth: "100%",
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},

			root: {
				display: "flex",
				flexDirection: "column",
				gap: "6px",
				padding: "10px 10px 14px",
				width: "100%",
				minWidth: "0",
				// No `height`. `auto` is what makes the content start at the top.
				height: "auto",
				boxSizing: "border-box",
				fontSize: "12px"
			},
			header: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: "6px",
				flex: "0 0 auto",
				minWidth: "0",
				paddingBottom: "6px",
				borderBottom: "1px solid rgba(128, 128, 128, 0.35)"
			},
			headerTitle: {
				display: "inline-flex",
				alignItems: "center",
				gap: "5px",
				flex: "0 0 auto",
				fontSize: "11px",
				letterSpacing: "0.04em",
				opacity: 0.6
			},
			headerMeta: {
				flex: "0 1 auto",
				minWidth: "0",
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
				fontSize: "11px",
				opacity: 0.6
			},
			/* The group name is a heading, so it truncates rather than wraps: two lines of
			   group name above a roster costs a row of people for no new information.
			   `0 0 auto` — it must never grow along the column axis (see root's comment). */
			groupName: {
				margin: 0,
				flex: "0 0 auto",
				minWidth: "0",
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
				fontSize: "12px",
				fontWeight: 600,
				opacity: 0.9
			},
			sectionLabel: {
				flex: "0 0 auto",
				fontSize: "11px",
				letterSpacing: "0.04em",
				opacity: 0.45,
				margin: "2px 0 0"
			},
			/* The roster list. `flex: 0 0 auto` so it sits at its natural height instead of
			   absorbing the column's leftover space. */
			roster: {
				display: "flex",
				flexDirection: "column",
				gap: "1px",
				flex: "0 0 auto",
				minWidth: "0"
			},
			/*
			 * 「所有人」 is a member row, not a banner.
			 *
			 * It shares {@link personRow} with everybody else — same height, same padding, same
			 * font — because that is what @所有人 looks like in WeChat / Feishu / Slack: the
			 * first row of the roster with a special name. An earlier version gave it a dashed
			 * border, which made it read as a dropdown or a button rather than as a row.
			 *
			 * The only difference is the leading glyph: an `@` instead of a presence dot. That
			 * is enough of a cue, and it says "broadcast" without a second visual language.
			 */
			personLead: {
				flex: "0 0 auto",
				width: "14px",
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				alignSelf: "flex-start",
				marginTop: "1px",
				opacity: 0.75
			},
			/* A person row: name line on top, group role underneath. Button reset in full so
			   it inherits the theme's type instead of the platform form-control styling. */
			personRow: {
				display: "flex",
				alignItems: "flex-start",
				gap: "6px",
				width: "100%",
				minWidth: "0",
				padding: "5px 6px",
				border: "1px solid transparent",
				borderRadius: "5px",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: "12px",
				textAlign: "left",
				cursor: "pointer"
			},
			/* The row I can edit, marked as such before the pointer arrives. */
			personRowSelf: {
				border: "1px solid currentColor",
				background: "rgba(76, 141, 255, 0.07)"
			},
			personBody: {
				flex: "1 1 auto",
				minWidth: "0",
				display: "flex",
				flexDirection: "column",
				gap: "1px"
			},
			personTop: {
				display: "flex",
				alignItems: "baseline",
				gap: "5px",
				minWidth: "0",
				width: "100%"
			},
			/* The only cell that shrinks: every sibling is `flex: 0 0 auto`. */
			personName: {
				flex: "0 1 auto",
				minWidth: "0",
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
				fontWeight: 600
			},
			selfTag: {
				flex: "0 0 auto",
				fontSize: "10px",
				padding: "0 4px",
				borderRadius: "7px",
				lineHeight: "14px",
				// An INVERTED chip: dark on light themes, light on dark ones. `currentColor` was used before,
				// which inverts only one element - a dark theme produced a near-white pill with white text,
				// i.e. invisible. `light-dark()` picks both sides; every root here declares colorScheme.
				background: "light-dark(#1a1a1a, #f2f2f2)",
				color: "light-dark(#f2f2f2, #1a1a1a)"
			},
			roleChip: {
				flex: "0 0 auto",
				fontSize: "10px",
				opacity: 0.55
			},
			editChip: {
				flex: "0 0 auto",
				marginLeft: "auto",
				fontSize: "10px",
				padding: "0 4px",
				border: "1px solid rgba(128, 128, 128, 0.35)",
				borderRadius: "7px",
				lineHeight: "14px",
				opacity: 0.75
			},
			/* Wraps and clamps: the group role is content, not decoration. */
			personAbout: {
				display: "-webkit-box",
				WebkitLineClamp: 2,
				WebkitBoxOrient: "vertical",
				overflow: "hidden",
				margin: 0,
				fontSize: "11px",
				lineHeight: "1.45",
				opacity: 0.7,
				whiteSpace: "normal",
				wordBreak: "break-word",
				overflowWrap: "anywhere"
			},
			/* My own row shows the whole sentence: it is the thing I am about to edit. */
			personAboutSelf: {
				display: "block",
				margin: 0,
				fontSize: "11px",
				lineHeight: "1.45",
				opacity: 0.8,
				whiteSpace: "normal",
				wordBreak: "break-word",
				overflowWrap: "anywhere"
			},
			aboutEmpty: {
				margin: 0,
				fontSize: "11px",
				lineHeight: "1.45",
				opacity: 0.45,
				fontStyle: "italic"
			},
			dot: {
				width: "6px",
				height: "6px",
				borderRadius: "50%",
				flex: "0 0 auto",
				marginTop: "6px"
			},
			hint: {
				margin: 0,
				fontSize: "11px",
				lineHeight: "1.5",
				opacity: 0.55,
				whiteSpace: "normal",
				wordBreak: "break-word"
			},
			// A small, quiet button. It sits beside the notice it fixes, so the reader does not have to learn
			// that a cache exists before being allowed to update one.
			// Small and quiet: the version is reference, not a status. Legible when looked for, invisible when not.
			versionTag: {
				fontSize: "11px",
				opacity: 0.5,
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
				whiteSpace: "nowrap"
			},
			// A per-row version chip: reference information that must be legible when looked for.
			versionChip: {
				fontSize: "10px",
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
				whiteSpace: "nowrap",
				flex: "0 0 auto"
			},
			// A rejoin is a CONTROL, not an input.
			//
			// Full width is right (it names a group, which can be long), but the height, radius and font size come
			// from buttonBase — otherwise it reads as a text field, which is what the first version looked like.
			// Sizes to its label, not to the pane.
			//
			// Full width was the single strongest signal that this was a text field rather than a control — the
			// reported symptom was exactly that. A long group name ellipsises instead of stretching the button.
			rejoinButton: {
				...buttonBase,
				maxWidth: "100%",
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
				textAlign: "left",
				justifyContent: "flex-start",
				margin: "0 0 4px 0",
				...buttonOutline
			},
			refreshButton: {
				...buttonBase,
				flex: "0 0 auto",
				padding: "2px 8px",
				...buttonOutline
			}
		};
		/**
		 * Write a whole draft sentence into the composer, through the owner's two-step API.
		 *
		 * Same contract as {@link insertMention}: `captureInsertion()` snapshots the
		 * selection and the draft revision, and `insertText(text, span)` is refused if the
		 * draft changed between the click and the write — which is the behaviour we want,
		 * because inserting an edit instruction at a stale caret would splice it into
		 * whatever the reader typed in the meantime.
		 *
		 * The one-argument `insertText(text)` form is NOT used: it silently returns false.
		 *
		 * @param {object|undefined} inputActions - the composer's action surface.
		 * @param {string} text - the text to insert.
		 * @returns {boolean} whether something was actually written.
		 */
		function fillDraft(inputActions, text) {
			try {
				if (inputActions === null || inputActions === undefined) return false;
				if (typeof inputActions.captureInsertion === "function"
					&& typeof inputActions.insertText === "function") {
					const span = inputActions.captureInsertion();
					return inputActions.insertText(text, span) === true;
				}
				// Last resort for a Host that only offers a whole-draft setter. It replaces
				// the draft, which is why it is the fallback and not the first choice.
				if (typeof inputActions.setDraft === "function") {
					inputActions.setDraft(text);
					return true;
				}
				return false;
			} catch (error) {
				reportUnavailable("inputActions.insertText", error);
				return false;
			}
		}

		/**
		 * Put a complete instruction in the composer, REPLACING whatever is there.
		 *
		 * `fillDraft` inserts at the caret, which is right for "@李四 " — you may be typing something around it. It is
		 * wrong for an instruction that is complete in itself: clicking the same button twice produced
		 *
		 *   用 a2a_group_join …  用 a2a_group_join …
		 *
		 * and the Session would then be asked to do it twice. Found by clicking the button, not by reading the code.
		 *
		 * @param {object|undefined} inputActions - the composer's action surface.
		 * @param {string} text - the instruction.
		 * @returns {boolean} whether it was written.
		 */
		function replaceDraft(inputActions, text) {
			try {
				if (inputActions === null || inputActions === undefined) return false;
				if (typeof inputActions.setDraft === "function") {
					inputActions.setDraft(text);
					return true;
				}
				// No whole-draft setter: fall back to inserting, which at worst duplicates rather than doing nothing.
				return fillDraft(inputActions, text);
			} catch (error) {
				reportUnavailable("inputActions.setDraft", error);
				return false;
			}
		}

		/**
		 * Members of the group the current Session belongs to, as a right-hand panel.
		 *
		 * Data comes from the same snapshot the central panel reads, filtered to the group
		 * this Session is in. The panel therefore shows nothing when the Session has not
		 * joined a group — which is correct, and says so, rather than listing strangers.
		 *
		 * ## The row order is IM order, not alphabetical
		 *
		 * 「所有人」 first because it is an address, not a person. 「我」 second and pinned,
		 * because "where am I in this list" is the question a reader asks on opening it, and
		 * because my row is the only one with a second action. Then everyone else, online
		 * before offline, then by name — presence is the fact that changes by the minute.
		 *
		 * ## Why the edit is an instruction and not a form
		 *
		 * See {@link draftGroupRoleEdit}: this bundle holds no membership credential, so it
		 * cannot write. Clicking my row fills the composer with a prefilled instruction and
		 * the Session turn — which does hold the credential — performs the write.
		 *
		 * Props provided by the slot owner: `sessionId` and `inputActions`.
		 */
		/**
		 * What the members pane shows in a conversation that has not joined a group.
		 *
		 * Three things, in the order a newcomer needs them: what the feature is, how to get in, and the
		 * one-step path for somebody who already has a link. The paste box fills the composer because
		 * this component has no credential — the Session turn performs the join.
		 *
		 * @param {object} props - `{ inputActions }`.
		 * @returns {object} the pane element.
		 */
		function UnboundMembersPane(props) {
			const inputActions = props !== null && props !== undefined ? props.inputActions : undefined;
			const [link, setLink] = react.useState("");

			// Groups this machine already belongs to, from a working directory this conversation does not serve.
			//
			// These need no invitation: the identity already exists here, and rejoining reuses it. Leading with a
			// link box would ask a member to prove themselves to a group they never left.
			//
			// ONE ENTRY PER GROUP, not per ledger record. A person who has moved twice has two or three records for the
			// same group — one per abandoned working directory — and every one of them passes the "held by another
			// Session" test. Listing them all showed 「发票与对账平台」 twice with identical labels, reported as
			// "it says two joined groups and that looks wrong". The reader is choosing a GROUP to re-enter, not a
			// record to adopt, so the group is the unit here.
			const rejoinable = (function () {
				const rows = props !== null && props !== undefined && props.snapshot !== undefined && props.snapshot !== null
					&& Array.isArray(props.snapshot.groups) ? props.snapshot.groups : [];
				const seen = {};
				const out = [];
				for (const row of rows) {
					if (row === null || row === undefined) continue;
					// A credential exists on this machine...
					if (row.canRejoinAs !== true) continue;
					// ...but not for this conversation. Without the second half the offer would appear for a group
					// this conversation is already in, which is the one case where it must not.
					//
					// The Host publishes one row per GROUP, so the row's own `sessionId` is only the newest holder.
					// `knownSessionIds` lists every Session that holds it, and THIS conversation counts as joined when
					// it appears anywhere in that set.
					const currentSession = props.sessionId === undefined || props.sessionId === null ? "" : props.sessionId;
					const holders = Array.isArray(row.knownSessionIds) && row.knownSessionIds.length > 0
						? row.knownSessionIds
						: [row.sessionId === undefined || row.sessionId === null ? "" : row.sessionId];
					if (currentSession === "") {
						if (holders.every(function (id) { return id === ""; })) continue;
					} else if (holders.indexOf(currentSession) > -1) {
						continue;
					}
					const key = String(row.id);
					if (seen[key] === true) continue;
					seen[key] = true;
					out.push(row);
				}
				return out;
			})();

			/** Hand the pasted link to the Session as a ready-to-send instruction. */
			function joinWithLink() {
				const trimmed = String(link ?? "").trim();
				if (trimmed === "") return;
				fillDraft(inputActions, "用 a2a_group_join 加入这个群：" + trimmed);
				setLink("");
			}

			return h(
				"div",
				{ style: membersLayout.root },
				h(
					"div",
					{ style: membersLayout.header },
					h("span", { style: membersLayout.headerTitle }, icon("users", 12), "协作群"),
					h("span", { style: membersLayout.headerMeta }, "未加入")
				),
				h(
					"div",
					{ style: membersLayout.unboundBody },
					// 1. What it is. Without this the pane is a form for something the reader cannot name.
					h(
						"p",
						{ style: membersLayout.unboundLead },
						"这个会话还没有加入协作群。协作群是几个同事一起干活的地方：消息、分工和上下文都留在群里，谁进来都能看到前因后果。"
					),
					// 2a. The common case: somebody sent me a link.
					// Rejoining comes FIRST. The link box is right exactly once — the first time — and wrong for everybody
					// who changed working directory while remaining a member. Their link is spent, and asking the owner
					// for a new one asks them to prove themselves to a group they never left.
					rejoinable.length === 0
						? null
						: h("div", null,
							h("div", { style: membersLayout.unboundStep }, "你已经在这些群里"),
							h("p", { style: membersLayout.unboundHint }, "这些群本机已经加入过，只是属于另一个会话（通常是上一个工作目录）。用同一个身份加入即可，不需要新邀请，群里也不会多出一个人。"),
							rejoinable.map(function (row) {
								return h(
									"button",
									{
										key: "rejoin-" + row.id,
										type: "button",
										style: membersLayout.rejoinButton,
										title: "用本机已有的身份加入，不需要邀请链接",
										onClick: function () {
											// An instruction rather than a direct call: joining needs a credential lookup the page does
											// not do, and the Session is where that lives.
											//
											// The instruction must NOT claim "no invite needed" unconditionally: rejoin works only when
											// THIS instance already holds a credential for the group in another Session, and
											// a2a_group_join reuses it by groupId. A fresh instance with no such credential still needs a
											// link — saying otherwise sent the model down a path that ends in missing_endpoint.
											replaceDraft(inputActions, "用 a2a_group_join 重新加入「" + row.name + "」：groupId 是 " + row.id
												+ "。本机若已有这个群的身份（在别的会话里加过），它会复用同一个身份、不会多出一个人；"
												+ "如果本机没有身份，请告诉我，我需要一个邀请链接。");
										}
									},
									row.name + (row.knownAs === "" ? "" : "（本机身份：" + row.knownAs + "）"),
								);
							}),
						),
					h("div", { style: membersLayout.unboundStep }, "② 或者，同事给了你邀请链接"),
					h(
						"p",
						{ style: membersLayout.unboundHint },
						"粘贴到下面，点「填入会话」，再按回车发送即可。"
					),
					h("textarea", {
						value: link,
						placeholder: "agent-a2a://group?v=1&…",
						rows: 2,
						spellcheck: false,
						onChange: function (event) {
							setLink(event !== null && event !== undefined && event.target !== undefined
								? event.target.value
								: "");
						},
						style: membersLayout.unboundInput
					}),
					h(
						"button",
						{
							type: "button",
							// Disabled while empty so the button cannot produce a half-sentence.
							disabled: String(link ?? "").trim() === "",
							title: "把加入指令填进输入框，按回车发送",
							style: Object.assign(
								{},
								membersLayout.unboundButton,
								String(link ?? "").trim() === "" ? membersLayout.unboundButtonOff : {}
							),
							onClick: joinWithLink
						},
						"填入会话"
					),
					// 2b. The other route, for somebody with no link.
					h("div", { style: membersLayout.unboundStep }, "③ 自己找群"),
					h(
						"p",
						{ style: membersLayout.unboundHint },
						"点左侧栏的「协作群」，从列表里挑一个申请加入；群主同意后你就会收到通知。"
					),
					// ④ Create one yourself. The only way in with no link, no invite, and nothing to browse — and the
					// entry point a new user needs to START a collaboration rather than only join somebody else's.
					h("div", { style: membersLayout.unboundStep }, "④ 新建一个群"),
					h(
						"p",
						{ style: membersLayout.unboundHint },
						"想自己开一个群？点下面的按钮，把「新建群」的指令填进输入框，改一下群名再发送。"
					),
					h(
						"button",
						{
							type: "button",
							style: membersLayout.unboundButton,
							title: "把新建群的指令填进输入框，改群名后按回车发送",
							onClick: function () {
								replaceDraft(inputActions, "用 a2a_group_create 新建一个群，群名叫「」，主题是「」。");
							}
						},
						"新建一个群"
					),
					// A thread somebody may already belong to. Saying so prevents the confusing case of
					// "I know I joined a group" while this pane insists otherwise.
					h(
						"p",
						{ style: membersLayout.unboundFootnote },
						"已经在别的会话里加入过群？那些群会出现在上面的「你已经在这些群里」，点一下就能用同一个身份进来——群里不会多出一个人，两边看到的是同一份消息。"
					)
				)
			);
		}

		/**
		 * The roster of a group, whichever name the data arrived under.
		 *
		 * `normalizeGroup` emits `members`; the raw injected snapshot uses `roster`. The pane is fed
		 * both, so it asks this instead of assuming — the alternative is a list that is mysteriously
		 * empty on one of the two paths.
		 *
		 * @param {object} group - the group row, normalized or raw.
		 * @returns {object[]} the roster, never undefined.
		 */
		function rosterOf(group) {
			if (group === null || group === undefined) return [];
			if (Array.isArray(group.members) && group.members.length > 0) return group.members;
			if (Array.isArray(group.roster)) return group.roster;
			if (Array.isArray(group.members)) return group.members;
			return [];
		}

		/**
		 * One person's id, whichever field the row carries.
		 *
		 * A card has `personId`; a normalized roster row has `id`. Comparing one to the other without
		 * this returns false for every pair, which is how "already in this group" stops working.
		 *
		 * @param {object} row - a card or a roster row.
		 * @returns {string} the id, or an empty string.
		 */
		function personIdOf(row) {
			if (row === null || row === undefined) return "";
			const direct = pickString(row.personId);
			if (direct !== "") return direct;
			return pickString(row.id);
		}

		/**
		 * The invite chooser.
		 *
		 * A dialog rather than a list inside the pane, because "who is in this group" and "who could
		 * join it" are different questions and a directory of a thousand answers the second one badly in
		 * a narrow column.
		 *
		 * Search is the primary control: nobody pages through a thousand colleagues, they type part of
		 * a name. The list under the box is what an empty search shows, capped, with the count stated —
		 * a silently truncated list makes a reader conclude somebody is not invitable.
		 *
		 * @param {object} props - `{ candidates, groupName, onPick, onClose }`.
		 * @returns {object} the overlay.
		 */
		function InviteDialog(props) {
			const [query, setQuery] = react.useState("");
			// Sending / sent-online / sent-offline / failed. `sending` also disables the list: each invitation
			// mints a single-use link, and a second click would mint a second live one.
			const [inviteState, setInviteState] = react.useState("idle");
			const [inviteNote, setInviteNote] = react.useState("");

			/** Send one invitation and record what happened. */
			function handleInvitePick(person) {
				if (panelRpcCaller === undefined) {
					// No channel: fall back to the instruction, so a host without Connection loses the
					// feedback rather than the ability to invite.
					fillDraft(props.inputActions, draftGroupInvite(props.group, person));
					props.onClose();
					return;
				}
				setInviteState("sending");
				setInviteNote("正在发送…");
				panelRpcCaller("/a2a-panel", "invite", {
					groupId: props.groupId,
					sessionId: props.sessionId,
					toPersonId: person.id,
				}).then(function (result) {
					if (result !== null && result !== undefined && result.ok === true) {
						const online = result.value !== undefined && result.value !== null && result.value.online === true;
						setInviteState("sent");
						setInviteNote(online
							? `已邀请 ${person.name}，对方在线，会立即收到`
							: `已邀请 ${person.name}，对方当前离线，上线后会看到`);
						return;
					}
					const code = result && result.error ? result.error.code : "unknown";
					setInviteState("failed");
					setInviteNote(`发送失败：${code}`);
				}).catch(function (error) {
					setInviteState("failed");
					setInviteNote("发送失败：" + String((error && error.message) || error));
				});
			}
			const candidates = Array.isArray(props.candidates) ? props.candidates : [];

			// Local, case-insensitive, and matched against the description too: a person looking for
			// "the DBA" should find 赵六 even if they cannot recall the name.
			const needle = String(query ?? "").trim().toLowerCase();
			const matched = needle === ""
				? candidates
				: candidates.filter(function (person) {
					const hay = (person.name + " " + (person.headline ?? "") + " " + (person.tags ?? []).join(" ")).toLowerCase();
					return hay.indexOf(needle) !== -1;
				});

			const LIMIT = 6;
			const shown = matched.slice(0, LIMIT);
			const hidden = matched.length - shown.length;

			return h(
				"div",
				{ style: membersLayout.dialogOverlay, onClick: props.onClose },
				// Clicks inside must not close: the overlay closes, the panel does not.
				h(
					"div",
					{ style: membersLayout.dialogPanel, onClick: function (event) { event.stopPropagation(); } },
					h(
						"div",
						{ style: membersLayout.dialogHeader },
						h("span", { style: { fontWeight: 600, fontSize: "13px" } }, "邀请同事入群"),
						h(
							"button",
							{
								type: "button",
								title: "关闭",
								style: membersLayout.dialogClose,
								onClick: props.onClose
							},
							"✕"
						)
					),
					h(
						"p",
						{ style: membersLayout.unboundHint },
						"选中的同事会收到一条消息，里面带着加入「" + (props.groupName ?? "这个群") + "」的链接。"
					),
					h("input", {
						type: "search",
						value: query,
						placeholder: "搜索名字、角色或标签…",
						autoFocus: true,
						onChange: function (event) {
							setQuery(event !== null && event !== undefined && event.target !== undefined
								? event.target.value
								: "");
						},
						style: membersLayout.dialogSearch
					}),
					matched.length === 0
						? h("p", { style: membersLayout.unboundHint }, "没有匹配的同事。")
						: h(
								"div",
								{ style: membersLayout.dialogList },
								shown.map(function (person) {
									return h(
										"button",
										{
											key: person.id,
											type: "button",
											style: membersLayout.dialogItem,
											title: "邀请 " + person.name + " 加入",
											// Disabled while a send is in flight: each invitation is single-use, and a
									// second click would mint a second live link.
									disabled: inviteState === "sending",
									onClick: function () { handleInvitePick(person); }
										},
										h("span", { style: { fontSize: "12px" } }, person.name),
										(person.headline ?? "") === ""
											? null
											: h("span", { style: { fontSize: "11px", opacity: 0.6 } }, person.headline)
									);
								})
							),
					// Stated rather than implied: a capped list with no count reads as "that is everybody".
					hidden > 0
						? h(
								"p",
								{ style: membersLayout.unboundHint },
								"还有 " + String(hidden) + " 位同事未显示，输入名字缩小范围。"
							)
						: null,
					inviteNote === ""
						? null
						: h(
								"p",
								{
									style: Object.assign(
										{},
										membersLayout.unboundHint,
										inviteState === "failed" ? { color: "#c0392b" } : {}
									)
								},
								inviteNote
							)
				)
			);
		}

		/**
		 * Human-confirmation settings for this conversation.
		 *
		 * WHY THE INHERIT SWITCH IS FIRST AND PROMINENT
		 *
		 * The profile holds a default; this pane holds one conversation's exceptions. Without a visible "follow the
		 * profile" switch, a conversation tuned once would silently stop following later changes to the default, and
		 * six months later nobody could explain why one conversation behaves differently from all the others.
		 *
		 * WHY THE EFFECTIVE VALUES ARE SHOWN WHILE INHERITING
		 *
		 * Controls that are greyed out still need to say what is actually in force. Otherwise the reader sees dimmed
		 * boxes and cannot tell whether confirmation is on or off right now.
		 */
		function ConfirmSettings(props) {
			const sessionId = props !== null && props !== undefined ? pickString(props.sessionId) : "";
			const [state, setState] = react.useState(null);
			const [note, setNote] = react.useState("");
			const [busy, setBusy] = react.useState(false);

			/** Read the three facts: profile default, this Session's override, and what is in force. */
			const reload = function () {
				if (typeof panelRpcCaller !== "function") {
					setNote("这个 Host 没有实时通道，无法读取设置。");
					return Promise.resolve();
				}
				return panelRpcCaller("/a2a-panel", "confirm-settings", { sessionId: sessionId })
					.then(function (result) {
						if (result !== null && result !== undefined && result.ok === true) {
							setState(result.value);
						} else {
							setNote("读取设置失败。");
						}
					})
					.catch(function (error) {
						setNote("读取设置失败：" + String(error && error.message ? error.message : error).slice(0, 80));
					});
			};

			react.useEffect(function () { void reload(); }, [sessionId]);

			/** Persist one change and adopt what the Host reports back as the truth. */
			const save = function (patch) {
				if (typeof panelRpcCaller !== "function") return Promise.resolve();
				setBusy(true);
				const current = state !== null && state !== undefined ? state : { inherit: true, effective: {} };
				// Send ONLY the fields this change touched.
				//
				// Sending the whole `effective` object looked simpler and produced a silent data loss: the copy in hand
				// is a snapshot, so a save issued from a stale render wrote the OLD values for every field the person had
				// not just changed — measured, three of four settings reverted to defaults while only the one being
				// edited survived. A partial patch cannot do that: the fields it does not name are never mentioned, so
				// the Host keeps whatever it already had.
				const body = {
					sessionId: sessionId,
					inherit: patch.inherit !== undefined ? patch.inherit === true : current.inherit !== false,
					humanConfirm: patch.humanConfirm,
				};
				return panelRpcCaller("/a2a-panel", "set-confirm-settings", body)
					.then(function (result) {
						if (result !== null && result !== undefined && result.ok === true) {
							setState(result.value);
							setNote("已保存。");
						} else {
							setNote("保存失败。");
						}
					})
					.catch(function (error) {
						setNote("保存失败：" + String(error && error.message ? error.message : error).slice(0, 80));
					})
					.then(function () { setBusy(false); });
			};

			if (state === null) {
				return h("div", { style: membersLayout.confirmBlock }, h("div", { style: membersLayout.muted }, note === "" ? "正在读取人工确认设置…" : note));
			}

			const inherit = state.inherit !== false;
			const effective = state.effective !== null && state.effective !== undefined ? state.effective : {};

			/** One labelled row. `disabled` follows inheritance, so the controls read as one block when following. */
			function row(label, control) {
				return h(
					"div",
					{ style: membersLayout.confirmRow },
					h("span", { style: membersLayout.confirmLabel }, label),
					control
				);
			}

			/** A select whose options are the closed sets the Host validates against. */
			function select(key, options) {
				return h(
					"select",
					{
						style: Object.assign({}, membersLayout.confirmSelect, inherit ? membersLayout.confirmDisabled : {}),
						disabled: inherit === true,
						value: String(effective[key] === undefined ? "" : effective[key]),
						onChange: function (event) {
							// One field only: see save() for why a whole-object write loses the others.
							const one = {};
							one[key] = key === "timeoutMs" ? Number(event.target.value) : event.target.value;
							void save({ humanConfirm: one });
						}
					},
					options.map(function (option) { return h("option", { value: option.value, key: option.value }, option.label); })
				);
			}

			return h(
				"div",
				{ style: membersLayout.confirmBlock },
				h("div", { style: membersLayout.confirmTitle }, "人工确认"),
				h(
					"div",
					{ style: membersLayout.muted },
					"收到同事的消息时，先让你本人确认，再开始处理。"
				),
				row(
					"沿用全局设置",
					h("input", {
						type: "checkbox",
						checked: inherit,
						onChange: function (event) { void save({ inherit: event.target.checked }); }
					})
				),
				row("启用人工确认", h("input", {
					type: "checkbox",
					checked: effective.enabled === true,
					disabled: inherit,
					onChange: function (event) {
						void save({ humanConfirm: { enabled: event.target.checked } });
					}
				})),
				row("什么时候问", select("trigger", [
					{ value: "mention", label: "被 @ 时" },
					{ value: "always", label: "每条消息" },
					{ value: "never", label: "从不" }
				])),
				row("确认方式", select("channel", [
					{ value: "question", label: "界面提问" },
					{ value: "im", label: "即时通讯消息（未实现）" }
				])),
				row("没人回答时", select("onTimeout", [
					{ value: "deny", label: "拒绝执行" },
					{ value: "allow", label: "仍然执行" },
					{ value: "never", label: "一直等下去" }
				])),
				row("等待时长", h("input", {
					type: "number",
					min: 10,
					max: 86400,
					step: 10,
					style: Object.assign({}, membersLayout.confirmNumber, inherit ? membersLayout.confirmDisabled : {}),
					disabled: inherit,
					value: String(Math.round(Number(effective.timeoutMs === undefined ? 300000 : effective.timeoutMs) / 1000)),
					onChange: function (event) {
						const seconds = Number(event.target.value);
						if (!Number.isFinite(seconds) || seconds < 1) return;
						void save({ humanConfirm: { timeoutMs: Math.round(seconds * 1000) } });
					}
				})),
				// The warning is the point: choosing to wait forever is the one option that can leave a turn blocked while
				// nobody is at the keyboard, and the person deserves to read that before picking it.
				String(effective.onTimeout) === "never"
					? h("div", { style: membersLayout.confirmWarn }, "⚠️ 选「一直等下去」后，你不在电脑前时收到需要确认的任务，那个会话会一直等待，直到你回来处理。")
					: null,
				String(effective.channel) === "im"
					? h("div", { style: membersLayout.confirmWarn }, "「即时通讯消息」尚未实现。选中它时，需要确认的动作会被拒绝并说明原因，不会静默放行。")
					: null,
				note === "" ? null : h("div", { style: membersLayout.muted }, note)
			);
		}

		function MembersPane(props) {
			const snapshot = useSnapshot();
			const inputActions = props !== null && props !== undefined ? props.inputActions : undefined;
			const sessionId = props !== null && props !== undefined ? pickString(props.sessionId) : "";

			// Whether a refresh is running, and what the last one said. The note is not decoration: an automatic
			// action with no visible outcome is indistinguishable from a broken one.
			const [refreshing, setRefreshing] = react.useState(false);
			const [refreshNote, setRefreshNote] = react.useState("");
			// One automatic attempt per group per mount. Without this a failed refresh would re-fire on every
			// render and hammer an unreachable host.
			// A Set kept in state rather than a ref: `useRef` is not used anywhere in this bundle and the subset
			// react implementation available here cannot be assumed to provide it. State is the safe choice.
			const [autoTried, setAutoTried] = react.useState({});

			/**
			 * Ask the Host to re-read this group's roster.
			 *
			 * The credential lives on this machine, so the refresh happens there and only the result travels back —
			 * the page holds no credential and, by design, cannot reach the group's host itself.
			 *
			 * @param {string} groupId - which group.
			 * @returns {Promise<void>} resolves when the attempt finished, successfully or not.
			 */
			const refreshRoster = function (groupId) {
				if (typeof panelRpcCaller !== "function") {
					setRefreshNote("这个 Host 没有实时通道，无法刷新。");
					return Promise.resolve();
				}
				setRefreshing(true);
				setRefreshNote("正在刷新…");
				return panelRpcCaller("/a2a-panel", "refresh", { groupId: groupId, sessionId: sessionId })
					.then(function (result) {
						if (result !== null && result !== undefined && result.ok === true) {
							const groups = result.value !== undefined && result.value !== null ? result.value.groups : undefined;
							replaceGroups(groups);
							setRefreshNote("已刷新。");
							return;
						}
						const code = result !== null && result !== undefined && result.error !== undefined ? result.error.code : "";
						const message = result !== null && result !== undefined && result.error !== undefined ? result.error.message : "";
						// Name the reason: "刷新失败" alone leaves the reader unable to tell a dead host from being
						// removed from the group.
						setRefreshNote(code === "not_member"
							? "刷新失败：本机已经没有这个群的成员凭证了。"
							: "刷新失败：" + (message === "" ? code : message));
					})
					.catch(function () {
						setRefreshNote("刷新失败：通道没有响应。");
					})
					.then(function () {
						setRefreshing(false);
					});
			};

			// Whether the invite chooser is open. Kept here rather than in the dialog so one Escape or
			// one pick closes it from the outside too.
			const [inviteOpen, setInviteOpen] = react.useState(false);
			// Whether my own row is being edited in place. Separate from `inviteOpen` because the two open
			// different surfaces and only one of them writes.
			const [editingRole, setEditingRole] = react.useState(false);

			// Which group this Session belongs to. A Session can hold several; the pane shows
			// the one with the most recent activity, because that is the one being worked in.
			const candidates = snapshot.groups.filter(function (group) {
				if (group.discovered === true) return false;
				if (sessionId === "") return true;
				return group.sessionId === "" || group.sessionId === sessionId;
			});
			candidates.sort(function (left, right) {
				return (right.lastTime || 0) - (left.lastTime || 0);
			});
			const group = candidates[0];

			// My build, and who is on a different one. A version belongs to a process, so this compares what each
			// member reported against what this instance is running.
			const selfVersion = snapshot !== undefined && snapshot !== null && typeof snapshot.selfVersion === "string"
				? snapshot.selfVersion
				: "";

			// Refresh automatically when the cache is already known to be stale, and only then.
			//
			// Refreshing on every open would spend another machine's network on data nobody asked for; refreshing
			// never leaves the reader looking at an hour-old roster with no way to fix it short of leaving the UI.
			// The button below covers everything auto does not.
			react.useEffect(function () {
				if (group === undefined || group === null) return;
				if (group.rosterStale !== true) return;
				const id = String(group.id);
				if (autoTried[id] === true) return;
				setAutoTried(function (previous) {
					const next = Object.assign({}, previous);
					next[id] = true;
					return next;
				});
				refreshRoster(id);
			}, [group === undefined || group === null ? "" : String(group.id), group === undefined || group === null ? false : group.rosterStale]);


			/** Insert `@name ` into the composer through the owner's two-step API. */
			function address(name) {
				fillDraft(inputActions, "@" + name + " ");
			}

			/** Fill the composer with the prefilled role-edit instruction. */
			function editOwnRole(current) {
				fillDraft(inputActions, draftGroupRoleEdit({
					groupName: group === undefined ? "" : group.name,
					groupId: group === undefined ? "" : group.id,
					about: current.about,
					tags: current.tags
				}));
			}

			if (group === undefined) {
				// A real pane, not one sentence: the entry point exists, so it owes the reader the three
				// answers a new conversation needs — what this is, how to join, and the one-step path
				// for somebody who already has a link.
				return h(UnboundMembersPane, { inputActions: inputActions, snapshot: snapshot, sessionId: sessionId });
			}

			// The snapshot may be normalized (`members`) or raw (`roster`); ask once, here.
			const members = rosterOf(group);

			// Who reports a different build than mine.
			//
			// Placed here, after `members`, because reading it earlier threw a ReferenceError that blanked the
			// whole pane — the failure mode of a hook used before its declaration, which no test caught because
			// the panel is exercised through its export rather than by mounting it.
			const versionMismatch = (function () {
				if (selfVersion === "") return [];
				return members.filter(function (member) {
					// Unknown is not a mismatch: we cannot claim somebody differs from us on no evidence.
					return member.clientVersion !== "" && member.clientVersion !== selfVersion;
				});
			})();
			const self = pickSelf(group, snapshot.cards);
			const split = splitRoster(members, self);
			// A roster that arrived without an `isSelf` marker still gets a 「我」 row: the
			// person table knows who I am even when the cached roster was written by a Host
			// that predates the marker. This synthesis is why `split.mine` can be absent while
			// `self.hasSelf` is true.
			if (split.mine === undefined && split.owner === undefined && self.hasSelf === true && self.personId !== "") {
				split.mine = {
					id: self.personId,
					name: self.name === "" ? "我" : self.name,
					role: "",
					roleAbout: self.about,
					tags: self.tags,
					online: self.online,
					self: true,
					isSelf: true
				};
			}

			// Counted from the roster we are about to draw, not from `group.onlineCount`.
			//
			// The cached count was computed when the roster was fetched, so an hour-old cache reported
			// "1 在线" beside a row that presenceOf now knows is away. Two numbers on one screen
			// disagreeing is worse than either being slightly stale.
			const onlineNow = members.filter(function (member) { return member.online === true; }).length;
			const countLine = String(group.memberCount || members.length) + " 人"
				+ (onlineNow > 0 ? " · " + String(onlineNow) + " 在线" : "");

			/**
			 * The body shared by every roster row, including 「所有人」.
			 *
			 * One builder for all of them is the point: the broadcast row differs only in its
			 * leading glyph and its name, so any future change to row rhythm (padding, chips,
			 * clamp) lands on it for free instead of drifting into a second visual language.
			 *
			 * @param {string} name - display text.
			 * @param {object} options - `about`, `role`, `badges` (extra chips), `aboutEmpty`.
			 * @returns {object} vnode for the row's text column.
			 */
			function rowBody(name, options) {
				const given = options === null || options === undefined ? {} : options;
				const about = pickString(given.about);
				const badges = Array.isArray(given.badges) ? given.badges : [];
				const chips = [];
				for (const badge of badges) {
					if (badge !== null && badge !== undefined) chips.push(badge);
				}
				return h(
					"span",
					{ style: membersLayout.personBody },
					h(
						"span",
						{ style: membersLayout.personTop },
						h("span", { style: membersLayout.personName }, name),
						chips.length === 0 ? null : chips,
						given.owner === true ? h("span", { style: membersLayout.roleChip }, "群主") : null,
						about !== "" || given.showEmptyRole !== true
							? null
							: h("span", { style: membersLayout.roleChip }, "未填群内介绍")
					),
					about === ""
						? given.emptyText === undefined
							? null
							: h("p", { style: membersLayout.aboutEmpty }, given.emptyText)
						: h("span", { style: given.full ? membersLayout.personAboutSelf : membersLayout.personAbout }, about)
				);
			}

			/**
			 * One roster row.
			 *
			 * There are exactly two behaviours, and which one applies is decided by one fact:
			 * whether this row is me.
			 *
			 *  - **me** → fill the composer with the role-edit instruction. I cannot @ myself,
			 *    so an @-mention here would be a click that produces nothing useful.
			 *  - **anyone else** (including the owner) → insert `@name `. That covers the
			 *    owner row too: addressing the owner is the common reason to click them.
			 *
			 * @param {object} member - normalized member, with `isSelf` when I am this row.
			 * @param {object} options - `lead` (glyph or `@`), `owner`, `editable`, `key`.
			 * @returns {object} vnode.
			 */
			function personRow(member, options) {
				const given = options === null || options === undefined ? {} : options;
				const isSelf = member.isSelf === true;
				const canEdit = isSelf && inputActions !== null && inputActions !== undefined;
				const about = isSelf ? pickString(self.about) : pickString(member.roleAbout);

				const badges = [];
				// Suppress the self chip when the display name already says 我: the row would read
				// 「我 我」, which looks like a bug rather than a label. The row is still marked as
				// mine by its accent border and its edit chip.
				if (isSelf && pickString(member.name) !== "我") {
					badges.push(h("span", { key: "me", style: membersLayout.selfTag }, "我"));
				}
				if (given.owner === true) badges.push(h("span", { key: "owner", style: membersLayout.roleChip }, "群主"));
				// The build this person reported, on their own row.
				//
				// One small chip per row, INCLUDING the ones that match. Showing it only when different would be
				// quieter, but then "everybody agrees" and "nobody reported" look identical, and the reader
				// cannot tell which rows were checked at all.
				if (member.clientVersion !== "") {
					const differs = member.clientVersion !== selfVersion;
					badges.push(h(
						"span",
						{
							key: "ver",
							// A different build is the one thing on this row worth noticing, so it gets colour; the
							// matching ones recede.
							style: Object.assign({}, membersLayout.versionChip, {
								color: differs ? "#d29922" : "inherit",
								opacity: differs ? 1 : 0.45
							}),
							title: differs
								? "版本与你不同（你是 v" + selfVersion + "）：行为差异可能来自版本，不是群的问题"
								: "与你相同的版本",
						},
						"v" + member.clientVersion
					));
				}
				// The edit affordance and the read-only note. These were dropped when the version chip was
				// inserted above them, and their absence is invisible in a screenshot — the row simply stopped
				// offering an action it had always offered.
				if (canEdit) badges.push(h("span", { key: "edit", style: membersLayout.editChip }, "编辑介绍"));
				if (isSelf && !canEdit) badges.push(h("span", { key: "ro", style: membersLayout.editChip }, "只读"));

				const label = isSelf
					? (canEdit
						? "点击修改我在这个群的介绍（会填入输入框，按回车发送）"
						: "这个面板拿不到输入框，无法发起编辑")
					: "点击在输入框里 @ " + member.name;

				const button = h(
					"button",
					{
						key: given.key === undefined ? member.id : given.key,
						type: "button",
						title: label,
						style: isSelf
							? Object.assign({}, membersLayout.personRow, membersLayout.personRowSelf)
							: membersLayout.personRow,
						onClick: function () {
							if (isSelf) {
				// Prefer the inline editor: it writes straight to the Host. Fall back to the composer
				// instruction only when the write channel is missing, and say which happened rather than
				// silently doing the other thing.
				if (panelRpcCaller !== undefined) {
					setEditingRole(true);
				} else {
					editOwnRole(self);
				}
			}
							else address(member.name);
						}
					},
					given.lead === undefined
						? h("span", {
							style: Object.assign({}, membersLayout.dot, {
								// Three states again: a member whose timestamp we never had must not be labelled "offline".
								background: member.online === true
									? "#3fb950"
									: member.online === false
										? "rgba(128, 128, 128, 0.5)"
										: "rgba(128, 128, 128, 0.28)"
							}),
							title: member.online === true
								? "在线"
								: member.online === false
									? "不在线"
									: "状态未知（还没有这个人的在线信息）"
						})
						: h("span", { style: membersLayout.personLead, "aria-hidden": "true" }, given.lead),
					rowBody(member.name, {
						about: about,
						owner: false,
						full: isSelf,
						showEmptyRole: !isSelf,
						emptyText: isSelf ? (canEdit ? "还没写群内介绍，点这一行添加" : "还没写群内介绍") : undefined,
						badges: badges
					})
				);

				// No separate "clear" control. Clearing is not a sibling of editing — it is the
				// empty case of it, and the edit draft already says so ("清空 about 就是删掉这条
				// 介绍"). A second destructive button under the row would be one more thing to
				// mis-click, and it has no IM precedent: WeChat and Feishu put destructive
				// actions inside the row's own ⋯ menu, never as a line of the list.
				//
				// When that ⋯ menu exists, clearing belongs there. Until then the edit path is
				// the only writer, which is also the property that keeps the credential on the
				// host.
				return button;
			}

			/**
			 * 「所有人」: a roster row, first, with an `@` instead of a presence dot.
			 *
			 * No dashed border and no separate padding — in WeChat / Feishu / Slack, @所有人 is
			 * simply the first line of the member list with a special name. The glyph is the
			 * whole cue.
			 */
			function broadcastRow() {
				return h(
					"button",
					{
						key: "broadcast",
						type: "button",
						title: "点击 @ 所有人",
						style: membersLayout.personRow,
						onClick: function () {
							address("所有人");
						}
					},
					// A literal `@`, not a glyph: it is the universal broadcast marker, it is what
					// the inserted text actually looks like, and no icon in the product set says
					// "everyone" more clearly than the character the reader is about to type.
					h("span", { style: membersLayout.personLead, "aria-hidden": "true" }, "@"),
					rowBody("所有人", { about: "", showEmptyRole: false })
				);
			}


			// One flat roster, in the order a person scans it:
			//
			//   所有人 → 群主 → 我 → 其他人
			//
			// 「所有人」 first because it is an address, not a person. 群主 second because they
			// are the one to ask when the group is stuck. 我 third because that is the row with
			// a second action. Everyone else by presence, then name.
			//
			// `split.owner` carries `isSelf` when I run the group, so that case renders exactly
			// one row (labelled 群主 · 我) rather than listing me twice.
			const rosterRows = [broadcastRow()];
			if (split.owner !== undefined) {
				rosterRows.push(personRow(split.owner, { key: "owner", owner: true }));
			}
			if (split.mine !== undefined) {
				rosterRows.push(personRow(split.mine, { key: "self" }));
			}
			if (split.others.length === 0 && members.length > 0 && split.owner === undefined && split.mine === undefined) {
				rosterRows.push(h("p", { key: "alone", style: membersLayout.hint }, "这个群目前只有你。"));
			}
			for (const member of split.others) rosterRows.push(personRow(member, {}));

			// Inviting lives HERE, not on the colleague card: the group is the subject of the action, so
			// the group is what the pane knows. Cards show the group the instruction guessed would have
			// come from — a first group the reader never picked.
			const invitable = (Array.isArray(snapshot.cards) ? snapshot.cards : [])
				.filter(function (card) {
					return card.isSelf !== true;
				})
				.filter(function (card) {
					// Somebody already in this group cannot be invited to it again.
					return !members.some(function (member) { return personIdOf(member) === personIdOf(card); });
				});

			// One quiet button. The choice happens in a dialog sized for choosing; an inline list either
			// crowds the roster (a big team) or hides its own extent (twelve shown, no count).
			function inviteRow() {
				if (invitable.length === 0) return null;
				return h(
					"div",
					{ style: membersLayout.inviteBlock },
					h(
						"button",
						{
							type: "button",
							title: "选择要拉进这个群的同事",
							style: membersLayout.inviteButton,
							onClick: function () { setInviteOpen(true); }
						},
						icon("users", 12),
						"邀请同事入群"
					)
				);
			}
			const pane = h(
				"div",
				{ style: membersLayout.root },
				h(
					"div",
					{ style: membersLayout.header },
					h(
						"span",
						{ style: membersLayout.headerTitle },
						icon("users", 12),
						"群成员"
					),
					// My build, always. Every debugging session this month opened by establishing which version was
					// running, twice by comparing file timestamps by hand — a visible version makes that a glance.
					selfVersion === ""
						? null
						: h(
							"span",
							{
								style: membersLayout.versionTag,
								title: "你运行的这个实例的版本",
							},
							"v" + selfVersion
						),
					h("span", { style: membersLayout.headerMeta }, countLine),
					// Always present, never merely when stale. A refresh control that appears only after the panel has
					// already gone stale gives the reader no way to check a group they suspect is out of date.
					group === undefined
						? null
						: h(
							"button",
							{
								type: "button",
								// A marker rather than a style: a member row and this control are both <button>
								// elements, and a test that reads "the buttons" needs a way to exclude this one.
								"data-role": "refresh",
								style: membersLayout.refreshButton,
								disabled: refreshing === true,
								title: "立刻向群里查一次最新成员",
								onClick: function () {
									if (refreshing === true) return;
									refreshRoster(String(group.id));
								}
							},
							refreshing === true ? "刷新中…" : "刷新"
						),
				),
				h("p", { style: membersLayout.groupName, title: group.topic === "" ? group.name : group.name + " · " + group.topic }, group.name),
				// A roster can be cached and simply old. Different from unreachable: we have no evidence anything
				// is wrong, we only know the list may have changed since it was fetched. Saying so is cheaper than
				// being confidently out of date.
				// The cache is old. Say so, and put the fix next to the complaint: the previous wording told the
				// reader their data was stale and then asked them to leave the UI and run a tool call, which is
				// homework rather than an interface.
				// The cache is old. The button now lives in the header, so this is a sentence rather than a
				// sentence plus a second control.
				group.rosterStale === true && Number(group.unreachableAt || 0) === 0
					? h(
							"p",
							{
								style: Object.assign({}, membersLayout.hint, { opacity: 0.7 }),
								title: "名单是上次查询缓存的，可能已经不是最新的。点右上角刷新。"
							},
							"名单来自缓存，可能已变化。"
						)
					: null,
				// Report the outcome. An automatic or button-triggered action with no visible result is
				// indistinguishable from one that silently did nothing.
				refreshNote === ""
					? null
					: h(
							"p",
							{
								style: Object.assign({}, membersLayout.hint, {
									opacity: 0.75,
									color: refreshNote.indexOf("失败") > -1 ? "#c0392b" : "inherit"
								})
							},
							refreshNote
						),
				members.length === 0
					? h("p", { style: membersLayout.hint }, "名单需要在会话里查一次（a2a_group_summary）才会出现。")
					: h("div", { style: membersLayout.roster }, rosterRows),
				editingRole && group !== undefined
					? h(RoleEditor, {
						groupId: group.id,
						sessionId: sessionId,
						displayName: (self !== null && self !== undefined ? self.name : "") || "",
						about: self.about,
						tags: self.tags,
						// Read from the person table, not the roster row: the headline is a person fact and a
						// roster written before it existed would not carry it.
						headline: (function () {
							const mine = (Array.isArray(snapshot.cards) ? snapshot.cards : []).filter(function (card) {
								return card.isSelf === true;
							})[0];
							return mine === undefined ? "" : (mine.headline ?? "");
						})(),
						onCancel: function () { setEditingRole(false); },
						onSaved: function () {
							// Close on success; the panel refreshes from the Host's next snapshot, so the new
							// value appears without a reload.
							setEditingRole(false);
						}
					})
					: null,
				inviteRow(),
				// Confirmation policy lives with the roster because that is where the person already is when they think
				// about how this group should behave.
				h(ConfirmSettings, { sessionId: sessionId }),
				inviteOpen
					? h(InviteDialog, {
							candidates: invitable,
							groupName: group.name,
							// The facts the dialog needs to send for itself: which group, which Session's credential,
							// and the composer for the no-channel fallback.
							groupId: group.id,
							sessionId: sessionId,
							group: group,
							inputActions: inputActions,
							onClose: function () { setInviteOpen(false); }
						})
					: null,
			);

			// The dialog is position: fixed, so it covers the viewport even though it is a child of the pane.
			// A fixed element is positioned against the viewport regardless of its ancestors, which is why the
			// pane's own overflow cannot clip it — and why no wrapper is needed.
			return pane;
		}


		/**
		 * Composer button that opens the members column.
		 *
		 * Lives in `conversation.input.left` beside the other small controls rather than in
		 * the global sidebar: the column shows THIS conversation's group, so a global
		 * destination for it would be a lie about its scope.
		 */
		function MembersButton(props) {
			const snapshot = useSnapshot();
			const sessionId = props !== null && props !== undefined ? pickString(props.sessionId) : "";

			// Which group THIS conversation is in decides the count, and whether the button is worth
			// showing at all. Without the session filter this took the most recently active group in
			// the whole instance, so a new conversation showed the member count of a group it had
			// never joined. The pane has always filtered this way; the button has to agree with it,
			// because two answers to one question show up as a visible contradiction.
			const joined = snapshot.groups.filter(function (group) {
				if (group.discovered === true) return false;
				if (sessionId === "") return true;
				// An older record with no session stamp belongs to whoever asks: turning a missing
				// field into a hidden feature is worse than showing it to the wrong conversation
				// once.
				return group.sessionId === "" || group.sessionId === sessionId;
			});
			// The button ALWAYS renders. Hiding it when nothing is bound made the entry point and the pane
			// depend on the same condition, so closing the pane left no way back. What changes is the
			// label: a count when bound, the feature's name when not — "群成员 0" would claim the group is
			// empty, which is a different and false statement.
			joined.sort(function (left, right) {
				return (right.lastTime || 0) - (left.lastTime || 0);
			});
			const group = joined[0];

			function openColumn() {
				try {
					// Record what happened on the window so a missing service is diagnosable
					// from the page instead of looking like a dead button. Cheap, and the only
					// way to see the difference between "no service" and "service refused".
					window.__dsh_a2a_open = {
						hasService: services.sidebarRight !== undefined,
						hasTabs: services.sidebarRightTabs !== undefined,
						kind: MEMBERS_TAB_KIND
					};
					const right = services.sidebarRight;
					if (right === undefined || typeof right.openTab !== "function") {
						window.__dsh_a2a_open.error = "sidebarRight.openTab unavailable";
						reportUnavailable("sidebarRight.openTab", undefined);
						return;
					}
					right.openTab(MEMBERS_TAB_KIND);
					window.__dsh_a2a_open.opened = true;
				} catch (error) {
					window.__dsh_a2a_open.error = String(error && error.message ? error.message : error);
					reportUnavailable("sidebarRight.openTab", error);
				}
			}

			return h(
				"button",
				{
					type: "button",
					title: group === undefined
						? "打开协作群面板：加入一个群，或查看当前群的成员"
						: "展开「" + group.name + "」的群成员，点人即可 @ 对方",
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: "4px",
						padding: "2px 8px",
						border: "1px solid rgba(128, 128, 128, 0.5)",
						borderRadius: "999px",
						background: "transparent",
						color: "inherit",
						font: "inherit",
						fontSize: "12px",
						cursor: "pointer"
					},
					onClick: openColumn
				},
				group === undefined ? "协作群" : "群成员",
				group !== undefined && group.memberCount > 0
					? h("span", { style: { opacity: 0.7 } }, String(group.memberCount))
					: null
			);
		}

		function GroupsPanel(props) {
			const snapshot = useSnapshot();
			const [expanded, toggle] = useExpanded();
			// One state object for the pair: switching tabs clears the tag filter, which is
			// what a person expects when they change the question they are asking.
			const local = useLocalState({ tab: "all", tag: "" });
			const state = local.value !== null && typeof local.value === "object"
				? local.value
				: { tab: "all", tag: "" };
			const tab = typeof state.tab === "string" ? state.tab : "all";
			const cards = typeof state.tag === "string" ? state.tag : "";

			const sections = groupByRelationship(snapshot.groups);
			const counts = {
				all: snapshot.groups.length,
				mine: sections.mine.length,
				joined: sections.joined.length,
				discover: sections.discover.length,
				cards: snapshot.cards.length
			};

			/** The group rows for the active tab; empty on the cards tab. */
			const activeGroups =
				tab === "mine"
					? sections.mine
					: tab === "joined"
						? sections.joined
						: tab === "discover"
							? sections.discover
							: tab === "cards"
								? []
								: snapshot.groups;

			/** Every tag present across the roster, so the filter offers real choices only. */
			const allTags = [];
			for (const card of snapshot.cards) {
				for (const tag of card.tags) if (allTags.indexOf(tag) < 0) allTags.push(tag);
			}
			allTags.sort();

			const visibleCards = cards === ""
				? snapshot.cards
				: snapshot.cards.filter(function (card) {
					return card.tags.indexOf(cards) > -1;
				});

			const groupBody = activeGroups.length === 0
				? h(
						"p",
						{ style: S.emptyBody },
						tab === "mine"
							? "还没有你管理的协作群。在会话里说「建个群叫 xxx」你就是群主。"
							: tab === "joined"
								? "这个会话还没有加入协作群。在「可加入」里找一个申请，或向同事要邀请链接。"
								: tab === "discover"
									// Distinguish 「the host has nothing more」 from 「we could not ask the host」. Both produce an
									// empty list, and only one of them is good news.
									? (snapshot.directoryError === ""
										? "宿主上没有更多可以加入的群了。"
										: `没能取到宿主的群目录：${snapshot.directoryError}`)
									: "还没有任何协作群。"
					)
				: h(
						"div",
						{ style: { display: "flex", flexDirection: "column", gap: "8px" } },
						activeGroups.map(function (group) {
							return h(GroupCard, {
								key: group.id,
								group: group,
								open: expanded[group.id] === true,
								onToggle: function () {
									toggle(group.id);
								}
							});
						})
					);

			const cardsBody = snapshot.cards.length === 0
				? h(
						"p",
						{ style: S.emptyBody },
						"还没有同事名片。名片由各人在群里声明的角色汇总而成——在会话里让助手查一次群成员即可。"
					)
				: h(
						"div",
						{ style: { display: "flex", flexDirection: "column", gap: "10px" } },
						h(TagFilter, {
							tags: allTags,
							active: cards,
							onSelect: function (value) {
								local.set({ tab: tab, tag: value });
							}
						}),
						visibleCards.length === 0
							? h("p", { style: S.emptyBody }, "没有标签为「" + cards + "」的同事。")
							: h(
									"div",
									{ style: { display: "flex", flexDirection: "column", gap: "6px" } },
									visibleCards.map(function (card) {
										return h(ColleagueCard, {
											key: card.id,
											card: card,
											// The composer API, so the self card can fill the draft. Only the
											// slot owner can provide it, which is why it is threaded down
											// rather than reached for.
											inputActions: props !== null && props !== undefined ? props.inputActions : undefined,
											// Named in the drafted instruction: the profile tool authenticates
											// through a group, so the text has to say which one.
											groupName: (function () {
												const mine = snapshot.groups.filter(function (group) {
													return group.discovered !== true;
												});
												return mine.length > 0 ? mine[0].name : "";
											})(),
											onPickTag: function (tag) {
												local.set({ tab: "cards", tag: tag });
											}
										});
									})
								)
					);

			// The wiring tab: show the exact config section this instance is running with, so a colleague can copy it
			// without finding a file. The YAML carries a MASKED key; the fields below show the masked key too, so no
			// path here can leak the secret into a screenshot or a pasted copy.
			const settingsData = snapshot.settings !== null && snapshot.settings !== undefined && typeof snapshot.settings === "object"
				? snapshot.settings
				: { yaml: "", fields: {} };
			const settingsFields = settingsData.fields !== null && settingsData.fields !== undefined && typeof settingsData.fields === "object"
				? settingsData.fields
				: {};
			const settingsBody = h(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: "10px" } },
				h("p", { style: S.emptyBody }, "这里是你这台机器接入协作群的配置。复制下面这段，贴到 profile 的 cordis.patch.yml 里（或让助手帮你改）。"),
				h(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: "6px" } },
					h("span", { style: { fontSize: "11px", opacity: 0.7 } }, "网关：" + (settingsFields.gatewayBase || "（未配置）")),
					h("span", { style: { fontSize: "11px", opacity: 0.7 } }, "你在网关里的名字：" + (settingsFields.agentName || "（未配置）")),
					h("span", { style: { fontSize: "11px", opacity: 0.7 } }, "插件版本：" + (settingsFields.version || "未知"))
				),
				h("pre", { style: { ...S.emptyBody, textAlign: "left", overflowX: "auto", padding: "8px", border: "1px solid rgba(128,128,128,0.3)", borderRadius: "6px" } }, settingsData.yaml || "（配置节尚未生成）"),
				h(
					"button",
					{
						type: "button",
						style: { ...S.emptyBody, cursor: "pointer", padding: "4px 8px", border: "1px solid currentColor", borderRadius: "4px" },
						title: "把配置节复制到剪贴板（密钥已脱敏）",
						onClick: function () {
							if (typeof navigator !== "undefined" && navigator !== null && typeof navigator.clipboard === "object"
								&& typeof navigator.clipboard.writeText === "function") {
								navigator.clipboard.writeText(settingsData.yaml || "").catch(function () {});
							}
						}
					},
					"复制配置"
				),
				h("p", { style: { fontSize: "10px", opacity: 0.55 } }, "密钥已脱敏，复制不会泄漏。要改配置，把这段贴给助手让它改 cordis.patch.yml。")
			);

			const tabs = PANEL_TABS.map(function (def) {
				return { id: def.id, label: def.label, icon: def.icon, count: counts[def.id] };
			});
			return h(
				"div",
				{ style: S.root },
				h(
					"div",
					{ style: S.header },
					h("h2", { style: S.title }, "协作群"),
					snapshot.unreadTotal > 0
						? h("span", { style: S.badge }, String(snapshot.unreadTotal) + " 条未读")
						: null,
					h("span", { style: S.hint }, "只读")
				),
				h(TabBar, {
					tabs: tabs,
					active: tab,
					onSelect: function (id) {
						local.set({ tab: id, tag: "" });
					}
				}),
				tab === "cards" ? cardsBody : tab === "settings" ? settingsBody : groupBody
			);
		}

		/** Two-person glyph, drawn inline so the row needs no extra dependency. */
		function GroupGlyph(props) {
			const given = props === null || props === undefined ? {} : props;
			const size = typeof given.size === "number" && given.size > 0 ? given.size : 16;
			const IconUsers = primitives.IconUsersOutlineRegular;
			if (typeof IconUsers === "function" || (IconUsers !== null && typeof IconUsers === "object")) {
				return h(IconUsers, { size: size });
			}
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.4,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true"
				},
				h("circle", { cx: 6, cy: 5.2, r: 2.3 }),
				h("path", { d: "M1.8 13.2c0-2.2 1.9-3.6 4.2-3.6s4.2 1.4 4.2 3.6" }),
				h("path", { d: "M10.7 3.2a2.3 2.3 0 0 1 0 4.2" }),
				h("path", { d: "M12.4 9.9c1.2.5 1.9 1.5 1.9 2.9" })
			);
		}

		/**
		 * Sidebar row glyph (registered into `sidebar.panellist`). The shell passes
		 * `{ size, active }`; unread total is drawn as a corner badge.
		 */
		function GroupsSidebarIcon(props) {
			const snapshot = useSnapshot();
			const given = props === null || props === undefined ? {} : props;
			const size = typeof given.size === "number" && given.size > 0 ? given.size : 16;
			return h(
				"span",
				{ style: S.sidebarGlyph },
				h(GroupGlyph, { size: size }),
				snapshot.unreadTotal > 0 ? h("span", { style: S.sidebarBadge }, snapshot.unreadTotal > 99 ? "99+" : String(snapshot.unreadTotal)) : null
			);
		}
		//#endregion

		//#region plugin surface
		/**
		 * Services this plugin hard-requires. `slots` is the only one: everything
		 * else (locale, layout) is read opportunistically through `ctx.get(...)`
		 * so a version skew silently degrades instead of parking the fiber.
		 */
		// `sidebarRight` and `sidebarRightTabs` are OPTIONAL services: declaring them makes
		// the right-column controller and its tab registry reachable, and Cordis keeps the
		// plugin running on a Host that does not provide them (which is why every use site
		// still checks for undefined).
		//
		// Without them in this list, `ctx.get("sidebarRight")` returns undefined: the
		// service exists, but this plugin never declared it, so the proxy guard refuses.
		const inject = ["slots", "sidebarRight", "sidebarRightTabs"];

		/** Registration failures are reported once, never thrown into the shell. */
		let reported = false;

		function reportUnavailable(stage, error) {
			if (reported) return;
			reported = true;
			warn("panel not mounted (" + stage + ")", error);
		}

		/**
		 * Client plugin body.
		 *
		 * Two registrations, both evidenced by shipped plugins:
		 *  - `sidebar.panellist` (list slot declared by @deepseek-ai/dsh-client-ui-sidebar;
		 *    consumed by schedule as `{ name, id, order, locale, label }` + glyph component);
		 *  - `main` (keyed slot declared by @deepseek-ai/dsh-client-ui-layout; the sidebar
		 *    row's `id` must equal this `key` or `layout.selectPanel` throws).
		 *
		 * @param ctx - browser fiber context; only `slots` is assumed present.
		 */
		function apply(ctx) {
			// Optional services: absent on a Host without the sidebar-right package, and a
			// missing one must cost the column, not the whole plugin.
			try {
				if (ctx !== null && ctx !== undefined && typeof ctx.get === "function") {
					services.sidebarRight = ctx.get("sidebarRight");
					services.sidebarRightTabs = ctx.get("sidebarRightTabs");
				}
			} catch (error) {
				reportUnavailable("sidebarRight lookup", error);
			}

			// The Host-facing caller for panel writes. Installed here because `ctx.connection` exists at apply time,
	// not at render time: the pane receives the call function as a prop rather than looking a service up.
	installPanelRpc(ctx);

	const slots = ctx === null || ctx === undefined ? undefined : ctx.slots;
			if (slots === undefined || slots === null || typeof slots.inject !== "function" || typeof slots.register !== "function") {
				reportUnavailable("slots service", undefined);
				return;
			}

			const panelPage = () => {
				try {
					return slots.register(
						{
							name: "main",
							key: PANEL_ID,
							label: "协作群"
						},
						GroupsPanel
					);
				} catch (error) {
					reportUnavailable("main slot register", error);
					return undefined;
				}
			};

			/**
			 * Register the members panel into the right column.
			 *
			 * `sidebar.right.pane.tab` is a keyed, session-scoped slot: the panel receives the
			 * current `sessionId` and the composer's `inputActions`, which is exactly what it
			 * needs and nothing more. A failure here must not stop the main panel from
			 * mounting, so it is reported and swallowed.
			 */
			const membersTab = () => {
				try {
					return slots.register(
						{
							name: "sidebar.right.pane.tab",
							key: MEMBERS_TAB_KEY
						},
						MembersPane
					);
				} catch (error) {
					reportUnavailable("sidebar.right.pane.tab register", error);
					return undefined;
				}
			};

			/**
			 * The tab's title chip.
			 *
			 * Registered separately because the owner dispatches body and title through
			 * different slots: a tab with a body but no title renders as blank chrome.
			 */
			const membersTabTitle = () => {
				try {
					return slots.register(
						{
							name: "sidebar.right.pane.tab.title",
							key: MEMBERS_TAB_KEY
						},
						function MembersTabTitle() {
							return h("span", { style: { fontSize: "12px" } }, "群成员");
						}
					);
				} catch (error) {
					reportUnavailable("sidebar.right.pane.tab.title register", error);
					return undefined;
				}
			};


			/**
			 * Declare the members page type.
			 *
			 * `priority: "extension"` because this type comes from outside the product: it
			 * outranks shipped viewers and may take over a builtin kind, which is the right
			 * posture for a page only this plugin can draw. `patterns` is omitted because a
			 * page type is opened by kind and recognizes no address.
			 */
			const membersTabType = () => {
				try {
					const tabs = services.sidebarRightTabs;
					if (tabs === undefined || tabs === null || typeof tabs.register !== "function") return undefined;
					return tabs.register({
						id: MEMBERS_TAB_KIND,
						kind: MEMBERS_TAB_KIND,
						priority: "extension",
						title: function () {
							return "群成员";
						}
					});
				} catch (error) {
					reportUnavailable("sidebarRightTabs.register", error);
					return undefined;
				}
			};

			/** Register the members page body under the tab definition id. */
			const membersTabBody = () => {
				try {
					return slots.register(
						{ name: "sidebar.right.pane.tab", key: MEMBERS_TAB_KIND },
						MembersPane
					);
				} catch (error) {
					reportUnavailable("sidebar.right.pane.tab register", error);
					return undefined;
				}
			};

			/** Register the tab chip text; a body without one renders as blank chrome. */
			const membersTabChip = () => {
				try {
					return slots.register(
						{ name: "sidebar.right.pane.tab.title", key: MEMBERS_TAB_KIND },
						function MembersTabChip() {
							return h("span", { style: { fontSize: "12px" } }, "群成员");
						}
					);
				} catch (error) {
					reportUnavailable("sidebar.right.pane.tab.title register", error);
					return undefined;
				}
			};

			/** The opener, in the composer tool row. */
			const membersButtonSlot = () => {
				try {
					return slots.register(
						{ name: "conversation.input.left", id: MEMBERS_TAB_KIND, order: 40 },
						MembersButton
					);
				} catch (error) {
					reportUnavailable("conversation.input.left register", error);
					return undefined;
				}
			};

			const sidebarRow = () => {
				try {
					return slots.register(
						{
							name: "sidebar.panellist",
							id: PANEL_ID,
							order: PANEL_ORDER,
							label: "协作群"
						},
						GroupsSidebarIcon
					);
				} catch (error) {
					reportUnavailable("sidebar slot register", error);
					return undefined;
				}
			};

			try {
				slots.inject("sidebar.panellist", sidebarRow);
			} catch (error) {
				reportUnavailable("sidebar.panellist inject", error);
			}
			try {
				slots.inject("main", panelPage);
			} catch (error) {
				reportUnavailable("main inject", error);
			}
			// Members render in the right column only; see MembersPane.

			// The right-hand members column. All four pieces are needed for it to appear:
			// the type so openTab has a kind, the body and chip so the seat can draw it, and
			// the button so a person can ask for it.
			try {
				slots.inject("sidebar.right.pane.tab", membersTabBody);
			} catch (error) {
				reportUnavailable("sidebar.right.pane.tab inject", error);
			}
			try {
				slots.inject("sidebar.right.pane.tab.title", membersTabChip);
			} catch (error) {
				reportUnavailable("sidebar.right.pane.tab.title inject", error);
			}
			try {
				slots.inject("conversation.input.left", membersButtonSlot);
			} catch (error) {
				reportUnavailable("conversation.input.left inject", error);
			}
			// The type registration is not a slot and needs no inject: it is live as soon as
			// it is registered, and it must exist before the first click.
			membersTabType();
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.PANEL_ID = PANEL_ID;
		exports.GLOBAL_KEY = GLOBAL_KEY;
		exports.CHANGE_EVENT = CHANGE_EVENT;
		exports.setDataSource = setDataSource;
		exports.readSnapshot = readSnapshot;
		exports.currentSnapshot = currentSnapshot;
		exports.subscribeGroups = subscribeGroups;
		exports.formatTime = formatTime;
		exports.GroupsPanel = GroupsPanel;
		exports.GroupsSidebarIcon = GroupsSidebarIcon;
		exports.GroupCard = GroupCard;
		exports.EmptyState = EmptyState;
		exports.MembersPane = MembersPane;
		exports.MembersButton = MembersButton;
		exports.pickSelf = pickSelf;
		exports.splitRoster = splitRoster;
		exports.draftGroupRoleEdit = draftGroupRoleEdit;
		exports.draftGroupInvite = draftGroupInvite;
		exports.draftGroupRoleClear = draftGroupRoleClear;
		exports.MEMBERS_TAB_KIND = MEMBERS_TAB_KIND;
		exports.MEMBERS_TAB_KEY = MEMBERS_TAB_KEY;
		exports.groupByRelationship = groupByRelationship;
		return module.exports;
	}
});