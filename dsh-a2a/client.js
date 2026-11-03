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

			// `members` is groups.js `members()`; the other two are conveniences.
			const membersRaw = Array.isArray(raw.members) ? raw.members : Array.isArray(raw.memberList) ? raw.memberList : Array.isArray(raw.roster) ? raw.roster : [];
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

			// Which group this Session belongs to. A Session can in principle hold several;
			// the panel shows the one with the most recent activity, because that is the one
			// the person is working in.
			const candidates = snapshot.groups.filter(function (group) {
				if (group.discovered === true) return false;
				if (sessionId === "") return true;
				return group.sessionId === "" || group.sessionId === sessionId;
			});
			candidates.sort(function (left, right) {
				return (right.lastTime || 0) - (left.lastTime || 0);
			});
			const group = candidates[0];

			/**
			 * Insert `@name ` into the composer.
			 *
			 * `inputActions` is the owner's API for changing the draft. Falling back to doing
			 * nothing is deliberate: a panel that silently fails to insert is better than one
			 * that writes into the DOM behind the composer's back and desynchronises it.
			 */
			function address(member) {
				const text = "@" + member.name + " ";
				try {
					const actions = props !== null && props !== undefined ? props.inputActions : undefined;
					if (actions !== null && actions !== undefined) {
						if (typeof actions.insertText === "function") {
							actions.insertText(text);
							return;
						}
						if (typeof actions.append === "function") {
							actions.append(text);
							return;
						}
						if (typeof actions.setDraft === "function") {
							actions.setDraft(text);
							return;
						}
					}
				} catch (error) {
					reportUnavailable("inputActions.insertText", error);
				}
			}

			if (group === undefined) {
				return h(
					"div",
					{ style: S.root },
					h("h2", { style: S.title }, "群成员"),
					h("p", { style: S.emptyBody }, "这个会话还没有加入协作群。加入后，成员会出现在这里，点击即可 @ 对方。")
				);
			}

			const members = group.members;
			return h(
				"div",
				{ style: S.root },
				h(
					"div",
					{ style: S.header },
					h("h2", { style: S.title }, "群成员"),
					h("span", { style: S.hint }, group.name)
				),
				h(
					"p",
					{ style: S.emptyBody },
					String(group.memberCount || members.length) + " 人"
						+ (group.onlineCount > 0 ? " · " + String(group.onlineCount) + " 人在线" : "")
						+ (members.length === 0 ? "（名单需在会话里让助手查一次）" : "")
				),
				members.length === 0
					? null
					: h(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: "2px" } },
							members.map(function (member) {
								return h(
									"button",
									{
										key: member.id,
										type: "button",
										title: "点击在输入框里 @ " + member.name,
										style: {
											display: "flex",
											alignItems: "center",
											gap: "6px",
											width: "100%",
											padding: "5px 6px",
											border: "none",
											borderRadius: "5px",
											background: "transparent",
											color: "inherit",
											font: "inherit",
											fontSize: "12px",
											textAlign: "left",
											cursor: "pointer"
										},
										onClick: function () {
											address(member);
										}
									},
									h(
										"span",
										{
											style: {
												width: "6px",
												height: "6px",
												borderRadius: "50%",
												flex: "0 0 auto",
												background: member.online ? "var(--dsh-color-success, #3fb950)" : "var(--dsh-color-border, #555)"
											}
										}
									),
									h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, member.name),
									member.role === "owner" ? h("span", { style: S.chip }, "群主") : null,
									member.role !== "" && member.role !== "owner" && member.role !== "member"
										? h("span", { style: S.chip }, member.role)
										: null
								);
							}),
							// One row for the whole group: the common case in a status post.
							h(
								"button",
								{
									key: "__all__",
									type: "button",
									title: "点击 @ 所有人",
									style: {
										marginTop: "6px",
										width: "100%",
										padding: "5px 6px",
										border: "1px solid var(--dsh-color-border, #444)",
										borderRadius: "5px",
										background: "transparent",
										color: "inherit",
										font: "inherit",
										fontSize: "12px",
										cursor: "pointer"
									},
									onClick: function () {
										address({ name: "所有人" });
									}
								},
								"@ 所有人"
							)
						)
			);
		}

		function GroupsPanel() {
			const snapshot = useSnapshot();
			const [expanded, toggle] = useExpanded();

			const sections = groupByRelationship(snapshot.groups);
			const total = snapshot.groups.length;
			const body =
				total === 0
					? h(EmptyState, null)
					: h(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: "14px" } },
							h(GroupSection, {
								title: "我创建的",
								hint: "可审批、可发邀请",
								groups: sections.mine,
								expanded: expanded,
								onToggle: toggle
							}),
							h(GroupSection, {
								title: "我参加的",
								groups: sections.joined,
								expanded: expanded,
								onToggle: toggle
							}),
							h(GroupSection, {
								title: "可加入",
								hint: "宿主上的公开群",
								groups: sections.discover,
								expanded: expanded,
								onToggle: toggle
							})
						);

			return h(
				"div",
				{ style: S.root },
				h(
					"div",
					{ style: S.header },
					h("h2", { style: S.title }, "协作群"),
					h("span", { style: S.hint }, snapshot.ok ? String(snapshot.groups.length) + " 个群" : "数据源未就绪"),
					snapshot.unreadTotal > 0 ? h("span", { style: S.badge }, String(snapshot.unreadTotal) + " 条未读") : null,
					h("span", { style: S.hint }, "只读")
				),
				body
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
		const inject = ["slots"];

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
			// The members panel belongs in the right column: it is session-scoped reference
			// material for the conversation beside it, not a destination of its own.
			try {
				slots.inject("sidebar.right.pane.tab", membersTab);
			} catch (error) {
				reportUnavailable("sidebar.right.pane.tab inject", error);
			}
			try {
				slots.inject("sidebar.right.pane.tab.title", membersTabTitle);
			} catch (error) {
				reportUnavailable("sidebar.right.pane.tab.title inject", error);
			}
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
		exports.MEMBERS_TAB_KEY = MEMBERS_TAB_KEY;
		exports.groupByRelationship = groupByRelationship;
		return module.exports;
	}
});
