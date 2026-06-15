/**
 * Owns a previous cache key and conditionally runs an effect when the key changes.
 *
 * Encapsulates the prev !== next comparison that previously lived in three places:
 * the session's inline `!==`, the handler's ask-then-tell orchestration, and the
 * (test-only-alive) `shouldApplyCachedAgentStartState` free function.
 *
 * Semantics:
 * - On a changed key: runs `effect`, commits `nextKey`, returns the effect's value.
 * - On an unchanged key: skips `effect`, returns `undefined`.
 * - `reset()` re-arms the gate (used by session lifecycle: `resetForNewSession`,
 *   `shutdown`, `reload`).
 *
 * Commit ordering is run-then-commit: the key is saved only after `effect` returns.
 * If `effect` throws, the key stays uncommitted and the next call retries.
 */
export class CacheKeyGate {
  private previousKey: string | null = null;

  runIfChanged<T>(nextKey: string, effect: () => T): T | undefined {
    if (this.previousKey === nextKey) {
      return undefined;
    }
    const result = effect();
    this.previousKey = nextKey;
    return result;
  }

  reset(): void {
    this.previousKey = null;
  }
}
