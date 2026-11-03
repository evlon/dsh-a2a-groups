/**
 * dsh-a2a — browser half public surface (`exports["./client"]`).
 *
 * This file is documentation-grade only: `client.js` is hand-written
 * JavaScript, not compiled TS. It exists so the Host half (`lib/index.js`) can
 * import the contract with full type checking instead of guessing.
 *
 * Loaded by the Web shell through `window.__ModuleLoader__.load({ id, factory })`;
 * nothing here describes Node-side code.
 */

/** Three-letter relative time label, e.g. `立即` / `3 分钟前` / `昨天 14:05`. */
export type GroupTimeLabel = string;

/** One roster member as the panel renders it. */
export interface A2aGroupMemberView {
	readonly id: string;
	readonly name: string;
	/** Free-form role/kind label; empty string when the Host has none. */
	readonly role: string;
	/** True for the session's own member — rendered as `名字（我）`. */
	readonly self: boolean;
}

/** One feed entry (also used for `lastMessage`). */
export interface A2aGroupFeedEntryView {
	readonly id: string;
	/** Monotonic sequence within the group; 0 when unknown. */
	readonly seq: number;
	readonly text: string;
	readonly senderName: string;
	/** Epoch milliseconds; 0 when unknown. */
	readonly time: number;
	/** Free-form kind (`chat` / `task` / …); empty string when unknown. */
	readonly kind: string;
}

/** One collaboration group, normalized. */
export interface A2aGroupView {
	readonly id: string;
	readonly name: string;
	readonly memberCount: number;
	readonly unreadCount: number;
	readonly lastMessage?: A2aGroupFeedEntryView;
	/** Epoch ms of the newest feed entry; 0 when the group has no messages. */
	readonly lastTime: number;
	readonly members: readonly A2aGroupMemberView[];
	/** Newest 20 entries, ascending by time. */
	readonly feed: readonly A2aGroupFeedEntryView[];
	readonly muted: boolean;
}

/** Normalized snapshot the components consume. */
export interface A2aGroupsSnapshot {
	readonly groups: readonly A2aGroupView[];
	/** Epoch ms the Host produced this snapshot; 0 when unknown. */
	readonly updatedAt: number;
	/** Sum of every group's `unreadCount`. */
	readonly unreadTotal: number;
	/** False when no Host data source was reachable at all. */
	readonly ok: boolean;
}

/**
 * What the Host may hand over. Every field is optional and every alias is
 * accepted, because `readSnapshot` must never throw on malformed input.
 */
export interface A2aGroupRaw {
	readonly id?: string;
	readonly groupId?: string;
	readonly name?: string;
	readonly title?: string;
	readonly memberCount?: number;
	readonly membersCount?: number;
	readonly unreadCount?: number;
	readonly unread?: number;
	readonly muted?: boolean;
	readonly members?: readonly unknown[];
	readonly feed?: readonly unknown[];
	readonly messages?: readonly unknown[];
	readonly lastMessage?: unknown;
}

/** Accepted container shapes for a snapshot. */
export type A2aGroupsRaw =
	| readonly A2aGroupRaw[]
	| { readonly groups?: readonly A2aGroupRaw[]; readonly items?: readonly A2aGroupRaw[]; readonly updatedAt?: number };

/** The preferred Host seam: `exports.setDataSource({ read, subscribe })`. */
export interface A2aGroupsDataSource {
	/** Must return the current raw snapshot; may be called on any render. */
	read(): A2aGroupsRaw | undefined;
	/** Optional push channel; the returned function unsubscribes. */
	subscribe?(listener: () => void): void | (() => void);
}

/** Slot service surface this plugin depends on (from `@deepseek-ai/dsh-client-ui-slots`). */
export interface A2aSlotsService {
	inject(name: string, callback: () => () => void): () => void;
	register(options: Record<string, unknown>, component: unknown): () => void;
}

/** Minimal browser context `apply()` accepts. Only `slots` is required. */
export interface A2aClientContext {
	readonly slots: A2aSlotsService;
	/** Optional: other services are probed defensively, never assumed. */
	readonly [service: string]: unknown;
}

/** A React component type, kept structural so this file needs no React dependency. */
export type A2aComponent = (props: Record<string, unknown>) => unknown;

/** Sidebar row glyph: receives `{ size, active }` from the shell. */
export declare const GroupsSidebarIcon: A2aComponent;
/** Central panel page: receives no props, reads the Host source itself. */
export declare const GroupsPanel: A2aComponent;
/** One group card, exported for tests and future reuse. */
export declare const GroupCard: A2aComponent;
/** `还没有加入任何群` block, exported for tests. */
export declare const EmptyState: A2aComponent;

/** Sidebar `id` and `main` `key`; the two must stay equal or `layout.selectPanel` throws. */
export declare const PANEL_ID: "a2a-groups";
/** Host global the panel reads when no data source is installed. */
export declare const GLOBAL_KEY: "__DSH_A2A_GROUPS__";
/** DOM event a Host may dispatch on `window` to force a re-read. */
export declare const CHANGE_EVENT: "dsh-a2a:groups-changed";

/** Services this plugin declares in the Cordis `inject` array. */
export declare const inject: readonly ["slots"];

/** Install (or clear) the Host data source. */
export declare function setDataSource(source: A2aGroupsDataSource | (() => A2aGroupsRaw | undefined) | null): void;
/** Normalize anything into a render-safe snapshot. */
export declare function readSnapshot(raw: unknown): A2aGroupsSnapshot;
/** Normalize whatever the Host currently exposes. */
export declare function currentSnapshot(): A2aGroupsSnapshot;
/** Subscribe to Host pushes; always returns a disposer. */
export declare function subscribeGroups(listener: () => void): () => void;
/** Render one epoch-ms instant as compact Chinese relative time. */
export declare function formatTime(time: number | undefined | null): GroupTimeLabel;

/** Client plugin body handed to the Cordis loader. */
export declare function apply(ctx: A2aClientContext): void;
