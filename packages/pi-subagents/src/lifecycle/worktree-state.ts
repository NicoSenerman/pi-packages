/**
 * worktree-state.ts — WorktreeState: lifecycle-phase object for worktree-isolated agents.
 *
 * Constructed once when the worktree is set up (before the run begins).
 * Only exists for agents with isolation: "worktree".
 * cleanupResult is recorded once at completion or error — it is not set at construction.
 */

import type { WorktreeCleanupResult, WorktreeInfo } from "#src/lifecycle/worktree";

export type { WorktreeCleanupResult, WorktreeInfo };

export class WorktreeState {
	/** Absolute path to the worktree directory. */
	readonly path: string;
	/** Branch name created for this worktree. */
	readonly branch: string;

	private _cleanupResult?: WorktreeCleanupResult;

	constructor(info: WorktreeInfo) {
		this.path = info.path;
		this.branch = info.branch;
	}

	/** Result of the worktree cleanup — undefined until recordCleanup is called. */
	get cleanupResult(): WorktreeCleanupResult | undefined {
		return this._cleanupResult;
	}

	/** Record the cleanup result. Called once on agent completion or error. */
	recordCleanup(result: WorktreeCleanupResult): void {
		this._cleanupResult = result;
	}
}
