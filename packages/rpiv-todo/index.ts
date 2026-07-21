/**
 * rpiv-todo — Pi extension. Registers the `todo` tool, `/todos` slash
 * command, and the persistent TodoOverlay widget.
 *
 * TUI chrome strings localize at render time via the i18n bridge. Strings are
 * registered with rpiv-i18n here, once, at module init — but only when the
 * SDK is actually installed. If `@juicesharp/rpiv-i18n` is missing (standalone
 * install of just this package), the dynamic-load shim no-ops and the bridge's
 * `t(key, fallback)` returns the inline English literal at every call site.
 * The extension stays online either way.
 *
 * Adding a locale: drop `locales/<code>.json` next to en.json (mirroring the
 * key set). No edit needed here — `registerLocalesFromDir` iterates
 * `SUPPORTED_LOCALES` from the SDK. See `@juicesharp/rpiv-i18n` README →
 * "Contributing translations" for the full convention.
 *
 * Extracted from rpiv-pi@7525a5d. Tool name "todo" and widget key
 * "rpiv-todos" preserved verbatim so existing session history replays
 * correctly after upgrade.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { resolveCollapseKey, COLLAPSE_KEY_OFF } from "./config.js";
import { I18N_NAMESPACE } from "./state/i18n-bridge.js";
import { clearState, orphanLegacyState, readState } from "./state/persistence.js";
import { replayFromBranch } from "./state/replay.js";
import { EMPTY_STATE, type TaskState } from "./state/state.js";
import { getTodos, replaceState } from "./state/store.js";
import {
	registerCleanTodoCommand,
	registerTodosCommand,
	registerTodoTool,
	setOnCleanTodosHook,
	TOOL_NAME,
} from "./todo.js";
import { TodoOverlay } from "./todo-overlay.js";

type I18nLoader = {
	registerLocalesFromDir: (namespace: string, packageUrl: string, options?: { label?: string }) => void;
};

// Dynamic import keeps `@juicesharp/rpiv-i18n` a soft optional peer: when the
// SDK is installed alongside this package the strings register and
// `/languages` flips them live; when it isn't, the import rejects here, we
// no-op, and the bridge's English-fallback shim keeps the extension online.
//
// The `/loader` subpath is used instead of the SDK entry so the i18n-ui +
// pi-tui modules are not pulled into our load graph just to register strings.
try {
	const sdk = (await import("@juicesharp/rpiv-i18n/loader")) as I18nLoader;
	sdk.registerLocalesFromDir(I18N_NAMESPACE, import.meta.url, {
		label: "rpiv-todo",
	});
} catch {
	// SDK absent — extension still loads with English-only UI.
}

// pi-core's ExtensionRunner throws this exact phrase from an invalidated ctx
// proxy after session replacement/reload. Match the stable substring so genuine
// replay bugs still propagate instead of being silently swallowed.
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

/**
 * Being spawned as a BACH subagent: the child session gets its own
 * `getSessionId()` (distinct from the parent) and its own persistence file —
 * which does not exist yet, so it starts from an empty slate. The parent's
 * open todos reach the child via the `before_agent_start` `## Open TODOs`
 * system-prompt block (the intended cross-session channel), NOT via the
 * persistence file. This guard additionally guarantees the child ignores any
 * empty-replay file fallback, defending against future code paths that might
 * read a sibling file before `getSessionId()`-scoped reads are wired.
 */
function isChildSession(): boolean {
	return process.env.PI_SUBAGENT_SESSION === "1";
}

/**
 * Branch replay is authoritative when it has data; the per-session file is the
 * fallback for BACH subagent forks whose branches lack the `todo` toolResult
 * (replay returns EMPTY_STATE there). When replay comes up empty and the
 * session's own file has a snapshot, use the file state instead.
 *
 * Session-scoped by `sessionId` (from `ctx.sessionManager.getSessionId()`) so
 * the fallback only ever reads the CURRENT session's file — never a sibling's
 * or the parent's. A freshly-spawned child (new UUID, no file) returns
 * EMPTY_STATE, and `isChildSession()` short-circuits the fallback entirely.
 */
function resolveState(sessionId: string, replayed: TaskState): TaskState {
	const isEmptyReplay = replayed.tasks.length === 0 && replayed.nextId === EMPTY_STATE.nextId;
	if (isEmptyReplay && !isChildSession()) {
		const file = readState(sessionId);
		if (file) return file;
	}
	return replayed;
}

/**
 * Auto-clear on session_start: if every non-deleted task is completed (no open
 * pending/in_progress tasks remain) and the list is non-empty, reset to a clean
 * slate and delete the persistence file — stops stale completed entries from
 * accumulating across sessions whose work is all done. No-op when there are
 * open tasks or the list is already empty. Returns the (possibly cleared)
 * state and whether it cleared, so the caller can clearState() only on a real
 * reset.
 */
function maybeAutoClearAllCompleted(state: TaskState): {
	state: TaskState;
	cleared: boolean;
} {
	if (state.tasks.length === 0) return { state, cleared: false };
	const hasOpen = state.tasks.some((t) => t.status === "pending" || t.status === "in_progress");
	if (hasOpen) return { state, cleared: false };
	return { state: { tasks: [], nextId: EMPTY_STATE.nextId }, cleared: true };
}

export default function (pi: ExtensionAPI) {
	// Todo overlay widget — constructed lazily at the first session_start with UI.
	let todoOverlay: TodoOverlay | undefined;

	registerTodoTool(pi);
	registerTodosCommand(pi);
	registerCleanTodoCommand(pi);

	// Collapse/expand hotkey for the todo overlay. The key is resolved once at
	// factory scope from config (register-once contract: a config change needs
	// `/reload` to re-bind) and the binding is skipped entirely when
	// collapseKey is "off". The handler closes over the closure-local
	// `todoOverlay` by reference and re-reads it at fire time, so a session_start
	// that (re)creates the overlay is picked up. No-op in headless mode, when
	// the overlay hasn't been created yet, or when the widget isn't currently
	// registered (auto-hidden on an empty list).
	const collapseKey = resolveCollapseKey();
	if (collapseKey !== COLLAPSE_KEY_OFF) {
		pi.registerShortcut(collapseKey as KeyId, {
			description: "Collapse or expand the todo overlay",
			handler: (ctx) => {
				if (!ctx.hasUI || !todoOverlay?.isRegistered()) return;
				todoOverlay.toggleCollapse();
			},
		});
	}

	// `/clean-todo` refreshes the overlay if it's been constructed for the
	// current session; called after the in-memory state + file are cleared.
	setOnCleanTodosHook(() => {
		todoOverlay?.resetCompletedDisplayState();
		todoOverlay?.update();
	});

	pi.on("session_start", async (event, ctx) => {
		// One-time cut-over: orphan the legacy process-wide state file so a stale
		// global snapshot can never be mis-attributed to a session after the move
		// to per-session isolation.
		orphanLegacyState();

		const sessionId = ctx.sessionManager.getSessionId();
		// `/new` is a new conversation — wipe todos + this session's host snapshot.
		// Only the CURRENT session's file is touched; sibling/parent/child
		// sessions keep their own files. The file fallback is only for
		// resume/fork/reload/startup when branch replay is empty, e.g. BACH kids.
		if (event.reason === "new") {
			clearState(sessionId);
			replaceState(EMPTY_STATE);
			if (ctx.hasUI) {
				todoOverlay ??= new TodoOverlay();
				todoOverlay.setUICtx(ctx.ui);
				todoOverlay.resetCompletedDisplayState();
				todoOverlay.update();
			}
			return;
		}

		let resolved = resolveState(sessionId, replayFromBranch(ctx));
		// Feature 4: auto-clear when every non-deleted task is completed — gives a
		// clean slate when resuming a session whose work is all done. Must run
		// BEFORE the overlay update() so the UI reflects the cleared state.
		const { state: afterAutoClear, cleared } = maybeAutoClearAllCompleted(resolved);
		if (cleared) {
			clearState(sessionId);
			resolved = afterAutoClear;
		}
		replaceState(resolved);
		if (ctx.hasUI) {
			todoOverlay ??= new TodoOverlay();
			todoOverlay.setUICtx(ctx.ui);
			todoOverlay.resetCompletedDisplayState();
			todoOverlay.update();
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		// Auto-compaction races session disposal: pi-core invalidates the
		// extension runner while still emitting session_compact, so `ctx` may be
		// a dead proxy whose getters throw the stale error. The compacting session
		// is being discarded — the replacement session's session_start replays
		// state — so keep current state on a stale ctx. Other errors are real
		// replay bugs and must propagate.
		try {
			replaceState(resolveState(ctx.sessionManager.getSessionId(), replayFromBranch(ctx)));
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		todoOverlay?.resetCompletedDisplayState();
		todoOverlay?.update();
	});

	pi.on("session_tree", async (_event, ctx) => {
		try {
			replaceState(resolveState(ctx.sessionManager.getSessionId(), replayFromBranch(ctx)));
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		todoOverlay?.resetCompletedDisplayState();
		todoOverlay?.update();
	});

	pi.on("session_shutdown", async () => {
		// Shutdown races session disposal the same way compact/tree do: pi-core
		// may invalidate the extension runner while still emitting the event, so
		// `dispose()`'s `setWidget` call can throw on a stale ctx. Guard with
		// try/finally so the overlay reference is always cleared even when the
		// dispose call fails — prevents a dangling overlay surviving into the
		// next session. Genuine errors propagate.
		try {
			todoOverlay?.dispose();
		} finally {
			todoOverlay = undefined;
		}
	});

	// Reads getTodos() at render time; do NOT call replayFromBranch here
	// (branch is stale — message_end runs after tool_execution_end).
	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== TOOL_NAME || event.isError) return;
		todoOverlay?.update();
	});

	pi.on("agent_start", async () => {
		todoOverlay?.hideCompletedTasksFromPreviousTurn();
	});

	// Auto-inject an `## Open TODOs (N)` summary into the system prompt so the
	// agent stays aware of open todos across subagent forks (which wipe the
	// in-memory list). Append (never replace) — pi-core chains systemPrompt
	// results from multiple extensions, so returning only our block would
	// stomp theirs. Return `{}` (no systemPrompt key) when clean so we don't
	// override the prompt at all.
	pi.on("before_agent_start", async (event) => {
		const open = getTodos().filter((t) => t.status === "pending" || t.status === "in_progress");
		if (open.length === 0) return {};
		const sorted = open.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id - b.id);
		const capped = sorted.slice(0, 15);
		const lines = capped.map(
			(t) => `- #${t.id} [${t.status}] ${t.subject}${t.activeForm ? ` — ${t.activeForm}` : ""}`,
		);
		const block = `## Open TODOs (${open.length})\n\n${lines.join("\n")}`;
		return { systemPrompt: event.systemPrompt + "\n\n" + block };
	});
}
