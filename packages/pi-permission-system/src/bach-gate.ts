/**
 * BACH-mode forced-ask gate.
 *
 * When BACH mode is active, destructive bash commands and external network
 * calls still prompt the user for approval instead of auto-approving.
 * This module provides pure pattern-matching predicates — mode checking
 * is the caller's responsibility.
 */

// ── Destructive command patterns ──────────────────────────────────────────

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  // rm with -r, -rf, -R, --recursive
  /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f?[a-zA-Z]*\s|--recursive\b)/,
  // git push --force / -f (includes --force-with-lease)
  /\bgit\s+push\s+.*(-f\b|--force\b)/,
  // wrangler deploy / delete / undeploy
  /\bwrangler\s+(deploy|delete|undeploy)\b/,
  // wrangler secret put
  /\bwrangler\s+secret\s+put\b/,
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
  // wrangler remote commands
  /\bwrangler\s+(deploy|delete|secret|uploads)\b/,
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
