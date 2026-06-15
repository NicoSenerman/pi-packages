import type { DenyWithReason, PermissionState } from "./types";

export function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

export function getNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Returns `raw` if it is an array of strings; otherwise `undefined`. */
export function normalizeOptionalStringArray(
  raw: unknown,
): string[] | undefined {
  return Array.isArray(raw) &&
    raw.every((p): p is string => typeof p === "string")
    ? raw
    : undefined;
}

/** Returns `raw` if it is a positive integer; otherwise `undefined`. */
export function normalizeOptionalPositiveInt(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0
    ? raw
    : undefined;
}

export function isPermissionState(value: unknown): value is PermissionState {
  return value === "allow" || value === "deny" || value === "ask";
}

/**
 * Narrow type guard: a raw value representing a DenyWithReason object.
 * Accepts `{ action: "deny" }` and `{ action: "deny", reason: "…" }`.
 * Rejects a non-string `reason` to keep malformed config out of the rule set.
 */
export function isDenyWithReason(value: unknown): value is DenyWithReason {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.action === "deny" &&
    (record.reason === undefined || typeof record.reason === "string")
  );
}

type StackNode = { indent: number; target: Record<string, unknown> };

export function parseSimpleYamlMap(input: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: StackNode[] = [{ indent: -1, target: root }];

  const lines = input.split(/\r?\n/);
  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
      continue;
    }

    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line
      .slice(0, separatorIndex)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    const rawValue = line.slice(separatorIndex + 1).trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1].target;

    if (!rawValue) {
      const child: Record<string, unknown> = {};
      current[key] = child;
      stack.push({ indent, target: child });
      continue;
    }

    let scalar = rawValue;
    if (
      (scalar.startsWith('"') && scalar.endsWith('"')) ||
      (scalar.startsWith("'") && scalar.endsWith("'"))
    ) {
      scalar = scalar.slice(1, -1);
    }

    current[key] = scalar;
  }

  return root;
}

export function extractFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return "";
  }

  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return "";
  }

  return normalized.slice(4, end);
}
