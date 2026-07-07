/**
 * BACH-mode forced-ask gate.
 *
 * When BACH mode is active, destructive bash commands and external network
 * calls still prompt the user for approval instead of auto-approving.
 * This module provides pure pattern-matching predicates — mode checking
 * is the caller's responsibility.
 */

// ── Wrangler mutating subcommands ─────────────────────────────────────────
//
// A single comprehensive pattern covering every wrangler subcommand path that
// mutates production state (deploys a Worker, promotes a version, rolls back,
// writes/deletes a secret, writes R2/KV, runs D1 SQL, creates triggers).
//
// The optional `(?:@\S+)?` between `wrangler` and the subcommand covers
// pinned-version invocations like `npx wrangler@3.10.0 deploy` and
// `bunx wrangler@latest secret put KEY`, where a package-version specifier
// separates the binary name from the subcommand (without it, the bare
// `\bwrangler\s+` anchor misses the `@` and silently auto-approves).
//
// Read-only subcommands are intentionally NOT matched so they keep
// auto-approving in BACH mode: `tail`, `secret list`, `deployments list`,
// `kv key list`, `kv namespace list`, `r2 bucket list`, `r2 object list`,
// `d1 list`, `d1 export`, `triggers list`, `versions list`, `whoami`,
// `dev`, `types`, `init`.
//
// `d1 execute` is flagged unconditionally (not just when the `--command`
// payload contains DROP/TRUNCATE): D1 execute runs arbitrary SQL against a
// production database — even a SELECT against prod is a mutating operation in
// the "side effects you can't undo from here" sense, and reliably extracting
// the quoted SQL payload from a shell command string is fragile across
// quoting styles. Flagging all `d1 execute` is the safe, simple choice.
//
// LIMITATION: this static regex cannot catch invocations where the literal
// `wrangler` token never appears in the command string — e.g. `npm run
// deploy`, `pnpm deploy`, or a shell alias that wraps `wrangler`.
// Catching those would require resolving the npm-script / alias target,
// which is out of scope for a command-string predicate.
const WRANGLER_MUTATING =
  /\bwrangler(?:@\S+)?\s+(?:deploy|delete|undeploy|versions\s+(?:upload|deploy)|deployments\s+rollback|secret\s+(?:put|delete|bulk)|r2\s+(?:object\s+put|bucket\s+(?:create|delete))|kv\s+(?:key\s+put|namespace\s+(?:create|delete))|d1\s+execute|triggers\s+create)\b/;

// ── Destructive command patterns ──────────────────────────────────────────

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  // rm with -r, -rf, -R, --recursive
  /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f?[a-zA-Z]*\s|--recursive\b)/,
  // git push (any form — force pushes AND plain pushes to any remote)
  /\bgit\s+push\b/,
  // wrangler mutating subcommands (see WRANGLER_MUTATING above)
  WRANGLER_MUTATING,
  // sudo (any command)
  /\bsudo\b/,
  // shutdown, reboot, halt, poweroff
  /\b(shutdown|reboot|halt|poweroff)\b/,
  // docker rm / rmi
  /\bdocker\s+(rm|rmi)\b/,
  // docker system prune
  /\bdocker\s+system\s+prune\b/,
  // docker volume prune / network prune
  /\bdocker\s+(volume|network)\s+prune\b/,
  // kubectl delete
  /\bkubectl\s+delete\b/,
  // SQL: DROP TABLE, DROP DATABASE, DROP SCHEMA, TRUNCATE
  /\b(DROP\s+TABLE|DROP\s+DATABASE|DROP\s+SCHEMA|TRUNCATE)\b/i,
];

// ── External network command patterns ─────────────────────────────────────

const EXTERNAL_NETWORK_TOOL_PATTERNS: RegExp[] = [
  // wrangler remote mutating commands (see WRANGLER_MUTATING above).
  // NOTE: bare `wrangler secret` is intentionally NOT matched here — it would
  // false-positive on read-only `wrangler secret list`. Only the mutating
  // secret forms (put|delete|bulk) are flagged.
  WRANGLER_MUTATING,
  // Cloudflare CLI push/deploy
  /\bcf\s+(push|deploy)\b/,
];

const LOCALHOST_PATTERN = /localhost|127\.0\.0\.1|::1/;

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Returns `true` when the command is destructive (rm -rf, sudo,
 * wrangler deploy, etc.).
 */
export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(command));
}

/**
 * Returns `true` when the command accesses an external network endpoint.
 *
 * - `curl` / `wget` to non-localhost URLs are flagged.
 * - Wrangler and Cloudflare CLI remote commands are flagged.
 */
export function isExternalNetworkCommand(command: string): boolean {
  // Check curl/wget — flag when the target URL is NOT localhost
  if (/\b(curl|wget)\b/.test(command)) {
    if (!LOCALHOST_PATTERN.test(command)) {
      return true;
    }
  }

  return EXTERNAL_NETWORK_TOOL_PATTERNS.some((re) => re.test(command));
}

/**
 * Combines destructive and external-network checks.
 *
 * Only meaningful when the caller has already confirmed BACH mode is active
 * — this function does not inspect the current mode itself.
 */
export function requiresBachPrompt(
  toolName: string,
  command: string | undefined,
): boolean {
  if (toolName !== "bash" || command === undefined) {
    return false;
  }
  return isDestructiveCommand(command) || isExternalNetworkCommand(command);
}
