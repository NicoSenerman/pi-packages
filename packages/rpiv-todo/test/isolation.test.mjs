/**
 * Per-session isolation test for rpiv-todo persistence.
 *
 * Reproduces the original concurrent-session bleed bug (a single fixed-path
 * file shared process-wide) and verifies the fix (per-session files scoped by
 * `getSessionId()`). Also covers the BACH subagent fresh-slate behavior.
 *
 * Run: `RPIV_TODO_STATE_DIR=<tmp> node --test test/isolation.test.mjs`
 *
 * Uses node:test + node:assert so it needs no vitest install. The persistence
 * module is imported dynamically AFTER `RPIV_TODO_STATE_DIR` is set so the
 * STATE_DIR const binds to the temp dir.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Must be set before importing persistence.js (the const binds at import).
const TMP = join(tmpdir(), `rpiv-todo-test-${process.pid}-${Date.now()}`);
process.env.RPIV_TODO_STATE_DIR = TMP;

const { writeState, readState, clearState, persistPathFor, orphanLegacyState } =
	await import("../state/persistence.ts");
// Note: persistence.ts is the bug locus (the old fixed-path file). store.ts
// merely calls into it, so testing persistence.ts in isolation fully covers
// the cross-session isolation fix. It has no relative runtime imports (only
// a type-only ./state import, elided by type-stripping), so it loads
// standalone under node --experimental-strip-types.
//
// The /clean-todo durable clear-marker logic (state/replay.ts) is NOT runtime-
// tested here: replay.ts imports ./state.js (a value import of EMPTY_STATE)
// and ../tool/types.js, which node's type-stripper cannot resolve to .ts
// (the package uses .js specifiers resolved by pi's TS loader). Its types are
// covered by tsc --noEmit, and its end-to-end behavior is verified live after
// restart.

function setup() {
	mkdirSync(TMP, { recursive: true });
}

function teardown() {
	rmSync(TMP, { recursive: true, force: true });
}

/** Build a minimal TaskState with one in_progress task. */
function stateOne() {
	return {
		tasks: [
			{ id: 1, subject: "session A task", status: "in_progress", priority: 0 },
		],
		nextId: 2,
	};
}

/** Build a minimal TaskState with one pending task, distinct from stateOne. */
function stateTwo() {
	return {
		tasks: [
			{ id: 1, subject: "session B task", status: "pending", priority: 0 },
		],
		nextId: 2,
	};
}

test("each session reads only its own file", () => {
	setup();
	try {
		const a = "11111111-1111-1111-1111-111111111111";
		const b = "22222222-2222-2222-2222-222222222222";
		writeState(a, stateOne());
		writeState(b, stateTwo());

		const ra = readState(a);
		const rb = readState(b);

		assert.equal(
			ra?.tasks[0].subject,
			"session A task",
			"session A reads its own task",
		);
		assert.equal(
			rb?.tasks[0].subject,
			"session B task",
			"session B reads its own task",
		);
		assert.notEqual(
			ra?.tasks[0].subject,
			rb?.tasks[0].subject,
			"no cross-session bleed",
		);
	} finally {
		teardown();
	}
});

test("a fresh child session finds no file and starts empty", () => {
	setup();
	try {
		const parent = "33333333-3333-3333-3333-333333333333";
		const child = "44444444-4444-4444-4444-444444444444";
		writeState(parent, stateOne());

		// Child never wrote a file → readState returns null (empty slate).
		assert.equal(
			readState(child),
			null,
			"child starts with no todos of its own",
		);
		assert.equal(existsSync(persistPathFor(child)), false, "child has no file");
	} finally {
		teardown();
	}
});

test("interleaved commits across two sessions never clobber each other", () => {
	setup();
	try {
		const a = "55555555-5555-5555-5555-555555555555";
		const b = "66666666-6666-6666-6666-666666666666";

		// Simulate concurrent BACH subagent + parent each calling todo.
		writeState(a, stateOne());
		writeState(b, stateTwo());
		writeState(a, {
			tasks: [
				{ id: 1, subject: "A updated", status: "completed", priority: 0 },
			],
			nextId: 2,
		});
		writeState(b, stateTwo());

		assert.equal(
			readState(a)?.tasks[0].subject,
			"A updated",
			"A kept its own update",
		);
		assert.equal(
			readState(b)?.tasks[0].subject,
			"session B task",
			"B unaffected by A's writes",
		);
	} finally {
		teardown();
	}
});

test("clearState only deletes the current session's file", () => {
	setup();
	try {
		const a = "77777777-7777-7777-7777-777777777777";
		const b = "88888888-8888-8888-8888-888888888888";
		writeState(a, stateOne());
		writeState(b, stateTwo());

		clearState(a);

		assert.equal(readState(a), null, "A cleared");
		assert.equal(
			readState(b)?.tasks[0].subject,
			"session B task",
			"B survives A's clear",
		);
	} finally {
		teardown();
	}
});

test("commitState-writes-to-session-own-file", () => {
	// Covers the same invariant via writeState directly (commitState is a thin
	// wrapper: store.commitState(sessionId, state) -> writeState(sessionId, state)).
	setup();
	try {
		const a = "99999999-9999-9999-9999-999999999999";
		writeState(a, stateOne());
		writeState("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", stateTwo()); // sibling commit

		// A's file is untouched — last-writer-wins no longer applies globally.
		assert.equal(
			readState(a)?.tasks[0].subject,
			"session A task",
			"A's file survived B's commit",
		);
	} finally {
		teardown();
	}
});

test("orphanLegacyState quarantines a legacy global file", async () => {
	setup();
	try {
		const legacyPath = join(TMP, "rpiv-todo-state.json");
		writeFileSync(
			legacyPath,
			JSON.stringify({ tasks: [], nextId: 1, version: 1 }),
			{ mode: 0o600 },
		);

		const orphaned = orphanLegacyState();

		assert.equal(orphaned, true, "legacy file was orphaned");
		assert.equal(
			existsSync(legacyPath),
			false,
			"legacy file gone from its original path",
		);
		// Calling again is a no-op.
		assert.equal(orphanLegacyState(), false, "second call is a no-op");
	} finally {
		teardown();
	}
});
