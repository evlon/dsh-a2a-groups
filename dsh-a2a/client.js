/**
 * dsh-a2a — browser half (DSH Web client plugin).
 *
 * HOW THIS FILE IS LOADED (mirrors every shipped plugin bundle):
 *   window.__ModuleLoader__.load({ id: "dsh-a2a", factory: (require) => exports })
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
	id: "dsh-a2a",
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

		/** The panel's tabs, in the order a person scans them. */
		const PANEL_TABS = [
			{ id: "all", label: "全部" },
			{ id: "mine", label: "我创建" },
			{ id: "joined", label: "我参与" },
			{ id: "cards", label: "同事名片" }
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

		/** One roster member. `memberId`/`displayName` are lib/groups.js `publicMember`. */
		function normalizeMember(raw, index) {
			if (!raw || typeof raw !== "object") return undefined;
			const name = pickString(firstDefined(raw, ["displayName", "name", "title", "label"]));
			const id = pickString(firstDefined(raw, ["memberId", "id", "sessionId", "key"])) || "member-" + String(index);
			return {
				id: id,
				name: name !== "" ? name : id,
				role: pickString(firstDefined(raw, ["role", "kind"])),
				online: raw.online === true,
				self: raw.self === true || raw.isSelf === true
			};
		}

		/**
		 * One feed / last-message entry.
		 *
		 * `seq`/`msgId`/`at`/`from:{memberId,displayName}`/`kind`/`text` is exactly
		 * `lib/groups.js` `publicEntry()`; the rest are conveniences for other Hosts.
		 */
		function normalizeEntry(raw, index) {
			if (!raw || typeof raw !== "object") return undefined;
			const text = pickString(firstDefined(raw, ["text", "body", "summary", "message", "content", "preview"]));
			// `from` is an object in groups.js (`{memberId, displayName}`), a string elsewhere.
			const from = raw.from;
			const fromName = from !== null && typeof from === "object" ? pickString(firstDefined(from, ["displayName", "name", "memberId"])) : pickString(from);
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

			// `lastPost` is lib/groups.js `snapshot()`; `lastMessage`/`last` are conveniences.
			const lastCandidate = firstDefined(raw, ["lastMessage", "lastPost", "last"]);
			const lastRaw = lastCandidate !== null && typeof lastCandidate === "object" ? lastCandidate : undefined;
			let lastMessage = lastRaw === undefined ? undefined : normalizeEntry(lastRaw, 0);
			if (lastMessage === undefined && recentFeed.length > 0) lastMessage = recentFeed[recentFeed.length - 1];
			// `lastPostAt` carries the timestamp even when only counts are readable.
			if (lastMessage !== undefined && lastMessage.time === 0) {
				const fallbackAt = pickTime(firstDefined(raw, ["lastPostAt", "lastMessageAt"]));
				if (fallbackAt > 0) lastMessage = { ...lastMessage, time: fallbackAt };
			}

			const declaredMemberCount = pickNumber(firstDefined(raw, ["memberCount", "membersCount", "memberTotal"]));
			const unreadCount = Math.max(0, Math.round(pickNumber(firstDefined(raw, ["unreadCount", "unread", "unreadTotal"]))));

			return {
				id: id,
				name: name,
				// `topic` is the secondary line in groups.js; shown as the card tooltip.
				topic: pickString(firstDefined(raw, ["topic", "description"])),
				memberCount: declaredMemberCount > 0 ? Math.round(declaredMemberCount) : members.length,
				unreadCount: unreadCount,
				lastMessage: lastMessage,
				lastTime: lastMessage === undefined ? 0 : lastMessage.time,
				members: members,
				feed: recentFeed,
				// `role` is the permission bit (owner | member). It decides which section
				// the group belongs to, because the ACTIONS differ: an owner approves and
				// invites, a member only reads and posts.
				role: pickString(firstDefined(raw, ["role", "permission"])) || "member",
				// A group that exists only as a directory row: not joined, so it belongs in
				// "discover" and its only action is "ask to join".
				discovered: raw.discovered === true || raw.joined === false,
				// Which Session this membership belongs to, when the Host says.
				sessionId: pickString(firstDefined(raw, ["sessionId", "session"])),
				muted: raw.muted === true || raw.mute === true
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
					updatedAt: updatedAt,
					unreadTotal: unreadTotal,
					ok: true
				};
			} catch (error) {
				return empty;
			}
		}

		/** Current snapshot straight from the Host, normalized. */
		function currentSnapshot() {
			return readSnapshot(readRaw());
		}

		/** Cheap change signature so polling only re-renders on real movement. */
		function signatureOf(snapshot) {
			let signature = String(snapshot.groups.length) + "|" + String(snapshot.unreadTotal);
			for (const group of snapshot.groups) {
				signature += "|" + group.id + ":" + String(group.memberCount) + ":" + String(group.unreadCount) + ":" + String(group.lastTime);
				const last = group.lastMessage;
				if (last !== undefined) signature += ":" + last.id + ":" + String(last.text.length);
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
				width: "12px",
				opacity: 0.6,
				fontSize: "10px"
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
			memberCount: {
				flex: "none",
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
				const refresh = () => {
					const next = currentSnapshot();
					const nextSignature = signatureOf(next);
					if (nextSignature === signature) return;
					signature = nextSignature;
					setSnapshot(next);
				};
				const dispose = subscribeGroups(refresh);
				let timer;
				if (typeof window !== "undefined" && window !== null && typeof window.setInterval === "function") {
					timer = window.setInterval(refresh, POLL_MS);
				}
				return () => {
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

		//#region components
		/** Empty state required by the contract: never an error, never a spinner. */
		function EmptyState() {
			return h(
				"div",
				{ style: S.empty },
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
				h("span", { style: S.chevron }, open ? "▾" : "▸"),
				h("span", { style: S.groupName }, group.name),
				group.unreadCount > 0 ? h("span", { style: S.badge }, group.unreadCount > 99 ? "99+" : String(group.unreadCount)) : null,
				h("span", { style: S.memberCount }, String(group.memberCount) + " 人")
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
								? h("span", { style: S.chip }, "名单需在会话里查看（a2a_group_role）")
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
					id: pickString(firstDefined(entry, [ "memberId", "id", "name" ])) || name,
					name: name,
					headline: pickString(firstDefined(entry, [ "headline", "role", "about" ])),
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
					online: entry.online === true
				});
			}
			return cards;
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
		 * Counts are shown on each tab because "我创建 (0)" is information: it says the
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
						borderBottom: "1px solid var(--dsh-color-border, #2a2f3a)",
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
							style: {
								padding: "6px 10px",
								border: "none",
								borderBottom: active
									? "2px solid var(--dsh-color-accent, #4c8dff)"
									: "2px solid transparent",
								background: "transparent",
								color: "inherit",
								font: "inherit",
								fontSize: "12px",
								fontWeight: active ? 600 : 400,
								opacity: active ? 1 : 0.7,
								cursor: "pointer"
							},
							onClick: function () {
								props.onSelect(tab.id);
							}
						},
						tab.label,
						tab.count === undefined ? null : h("span", { style: { opacity: 0.6, marginLeft: "4px" } }, String(tab.count))
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
							? "1px solid var(--dsh-color-accent, #4c8dff)"
							: "1px solid var(--dsh-color-border, #2a2f3a)",
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
										background: "var(--dsh-color-accent, #4c8dff)",
										color: "#fff"
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
											border: "1px solid var(--dsh-color-border, #444)",
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
				card.groups.length === 0
					? null
					: h(
							"div",
							{ style: { display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap" } },
							h("span", {
								style: {
									width: "5px",
									height: "5px",
									borderRadius: "50%",
									flex: "0 0 auto",
									background: card.online
										? "var(--dsh-color-success, #3fb950)"
										: "var(--dsh-color-border, #555)"
								},
								title: card.online ? "最近在群里活动过" : "最近没有活动"
							}),
							h(
								"span",
								{ style: { fontSize: "11px", opacity: 0.65 } },
								card.groups.slice(0, 3).join("、")
									+ (card.groups.length > 3 ? " 等 " + String(card.groups.length) + " 个群" : "")
							)
						),
				// Where the edit happens. Stated on the card because the panel cannot host an
				// editor: the profile is group-scoped and lives on the host, so the change has to
				// go through a Session that holds the credential.
				card.isSelf === true
					? h(
							"span",
							{ style: { fontSize: "10px", opacity: 0.55 } },
							"这是你自己的名片：在会话里说「我在这个群负责 X，标签 A、B」即可更新，或让助手帮你生成"
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
								border: "1px solid var(--dsh-color-border, #444)",
								borderRadius: "999px",
								background: active ? "var(--dsh-color-accent, #4c8dff)" : "transparent",
								color: active ? "#fff" : "inherit",
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
		 * Deliberately not `S.root`: that one belongs to the central panel, where 16px of
		 * padding and full width are correct. In a 280px column the same numbers waste a
		 * tenth of the width and let a name wrap onto two lines.
		 *
		 * `maxWidth` bounds it on a very wide screen: a roster 900px wide would be all
		 * whitespace between a name and its role chip.
		 */
		const membersLayout = {
			root: {
				display: "flex",
				flexDirection: "column",
				gap: "2px",
				padding: "10px 8px",
				height: "100%",
				minHeight: "0",
				maxWidth: "300px",
				overflowY: "auto",
				boxSizing: "border-box",
				fontSize: "12px"
			},
			header: {
				display: "flex",
				alignItems: "baseline",
				justifyContent: "space-between",
				gap: "6px",
				paddingBottom: "6px",
				marginBottom: "2px",
				borderBottom: "1px solid var(--dsh-color-border, #2a2f3a)"
			},
			/* One row: dot, name, role. `minWidth: 0` lets the name truncate instead of
			   forcing the row wider than the column. */
			row: {
				display: "flex",
				alignItems: "center",
				gap: "6px",
				width: "100%",
				minWidth: "0",
				padding: "4px 6px",
				border: "none",
				borderRadius: "4px",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: "12px",
				textAlign: "left",
				cursor: "pointer"
			},
			/* The name is the only flexible cell, so it absorbs the shrinkage. */
			name: {
				flex: "1 1 auto",
				minWidth: "0",
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			role: {
				flex: "0 0 auto",
				fontSize: "11px",
				opacity: 0.6
			},
			dot: {
				width: "6px",
				height: "6px",
				borderRadius: "50%",
				flex: "0 0 auto"
			},
			footer: {
				marginTop: "auto",
				paddingTop: "8px",
				borderTop: "1px solid var(--dsh-color-border, #2a2f3a)"
			}
		};
		/**
		 * Members of the group the current Session belongs to, as a right-hand panel.
		 *
		 * Data comes from the same snapshot the central panel reads, filtered to the group
		 * this Session is in. The panel therefore shows nothing when the Session has not
		 * joined a group — which is correct, and says so, rather than listing strangers.
		 *
		 * Props provided by the slot owner: `sessionId` and `inputActions`.
		 */
		function MembersPane(props) {
			const snapshot = useSnapshot();
			const sessionId = props !== null && props !== undefined ? pickString(props.sessionId) : "";

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

			/** Insert `@name ` into the composer through the owner's two-step API. */
			function address(member) {
				insertMention(props !== null && props !== undefined ? props.inputActions : undefined, member.name);
			}

			if (group === undefined) {
				return h(
					"div",
					{ style: membersLayout.root },
					h(
						"div",
						{ style: membersLayout.header },
						h("span", { style: S.sectionLabel }, "群成员")
					),
					h("p", { style: S.emptyBody }, "这个会话还没有加入协作群。")
				);
			}

			const members = group.members;
			const countLine = String(group.memberCount || members.length) + " 人"
				+ (group.onlineCount > 0 ? " · " + String(group.onlineCount) + " 在线" : "")
				+ (members.length === 0 ? "（名单需在会话里查一次）" : "");

			return h(
				"div",
				{ style: membersLayout.root },
				h(
					"div",
					{ style: membersLayout.header },
					h("span", { style: S.sectionLabel }, "群成员"),
					h("span", { style: membersLayout.role }, countLine)
				),
				h(
					"p",
					{ style: { margin: "0 0 4px", fontSize: "11px", opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
					group.name
				),
				members.length === 0
					? null
					: h(
							"div",
							{ style: { display: "flex", flexDirection: "column" } },
							members.map(function (member) {
								return h(
									"button",
									{
										key: member.id,
										type: "button",
										title: "点击在输入框里 @ " + member.name,
										style: membersLayout.row,
										onClick: function () {
											address(member);
										}
									},
									h("span", {
										style: Object.assign({}, membersLayout.dot, {
											background: member.online
												? "var(--dsh-color-success, #3fb950)"
												: "var(--dsh-color-border, #555)"
										})
									}),
									h("span", { style: membersLayout.name }, member.name),
									member.role === "owner" ? h("span", { style: membersLayout.role }, "群主") : null
								);
							})
						),
				h(
					"div",
					{ style: membersLayout.footer },
					h(
						"button",
						{
							type: "button",
							title: "点击 @ 所有人",
							style: Object.assign({}, membersLayout.row, {
								justifyContent: "center",
								border: "1px dashed var(--dsh-color-border, #444)"
							}),
							onClick: function () {
								address({ name: "所有人" });
							}
						},
						"@ 所有人"
					)
				)
			);
		}


		/**
		 * Composer button that opens the members column.
		 *
		 * Lives in `conversation.input.left` beside the other small controls rather than in
		 * the global sidebar: the column shows THIS conversation's group, so a global
		 * destination for it would be a lie about its scope.
		 */
		function MembersButton() {
			const snapshot = useSnapshot();
			// Which group this conversation is in decides the count on the button, and
			// whether the button is worth showing at all.
			const joined = snapshot.groups.filter(function (group) {
				return group.discovered !== true;
			});
			if (joined.length === 0) return null;
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
					title: "展开「" + group.name + "」的群成员，点人即可 @ 对方",
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: "4px",
						padding: "2px 8px",
						border: "1px solid var(--dsh-color-border, #444)",
						borderRadius: "999px",
						background: "transparent",
						color: "inherit",
						font: "inherit",
						fontSize: "12px",
						cursor: "pointer"
					},
					onClick: openColumn
				},
				"群成员",
				group.memberCount > 0 ? h("span", { style: { opacity: 0.7 } }, String(group.memberCount)) : null
			);
		}

		function GroupsPanel() {
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
				cards: snapshot.cards.length
			};

			/** The group rows for the active tab; empty on the cards tab. */
			const activeGroups =
				tab === "mine"
					? sections.mine
					: tab === "joined"
						? sections.joined
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
							? "还没有创建过协作群。在会话里说「建个群叫 xxx」即可。"
							: tab === "joined"
								? "这个会话还没有加入协作群。在「全部」里找一个申请加入，或向同事要邀请链接。"
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
											onPickTag: function (tag) {
												local.set({ tab: "cards", tag: tag });
											}
										});
									})
								)
					);

			const tabs = PANEL_TABS.map(function (def) {
				return { id: def.id, label: def.label, count: counts[def.id] };
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
				tab === "cards" ? cardsBody : groupBody
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
		exports.MEMBERS_TAB_KIND = MEMBERS_TAB_KIND;
		exports.MEMBERS_TAB_KEY = MEMBERS_TAB_KEY;
		exports.groupByRelationship = groupByRelationship;
		return module.exports;
	}
});
