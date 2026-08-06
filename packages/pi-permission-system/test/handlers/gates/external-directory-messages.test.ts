import { describe, expect, test } from "vitest";

import {
  formatBashExternalDirectoryAskPrompt,
  formatExternalDirectoryAskPrompt,
} from "#src/handlers/gates/external-directory-messages";

// Denial message functions (formatExternalDirectoryDenyReason,
// formatExternalDirectoryUserDeniedReason, formatExternalDirectoryHardStopHint,
// formatBashExternalDirectoryDenyReason) have moved to denial-messages.ts.
// Their behavior is tested in denial-messages.test.ts.

describe("formatExternalDirectoryAskPrompt", () => {
  test("uses 'Current agent' when no agent name provided", () => {
    const result = formatExternalDirectoryAskPrompt(
      "read",
      "/etc/passwd",
      "/projects/my-app",
    );
    expect(result).toContain("Current agent");
    expect(result).toContain("read");
    expect(result).toContain("/etc/passwd");
    expect(result).toContain("/projects/my-app");
  });

  test("uses agent name when provided", () => {
    const result = formatExternalDirectoryAskPrompt(
      "write",
      "/tmp/out.txt",
      "/projects/my-app",
      "my-agent",
    );
    expect(result).toContain("Agent 'my-agent'");
    expect(result).toContain("write");
    expect(result).toContain("/tmp/out.txt");
  });
});

describe("formatBashExternalDirectoryAskPrompt", () => {
  test("includes command, paths, cwd, and agent name", () => {
    const result = formatBashExternalDirectoryAskPrompt(
      "cat /etc/passwd",
      ["/etc/passwd"],
      "/projects/my-app",
      "my-agent",
    );
    expect(result).toContain("Agent 'my-agent'");
    expect(result).toContain("  cat /etc/passwd");
    expect(result).toContain("/etc/passwd");
    expect(result).toContain("/projects/my-app");
    expect(result).toMatch(/Allow this external directory access\?\n\n  cat/);
  });

  test("uses 'Current agent' when no agent name provided", () => {
    const result = formatBashExternalDirectoryAskPrompt(
      "ls /tmp",
      ["/tmp"],
      "/projects/my-app",
    );
    expect(result).toContain("Current agent");
  });

  test("does not inline the command inside single quotes", () => {
    const result = formatBashExternalDirectoryAskPrompt(
      "cat /etc/passwd",
      ["/etc/passwd"],
      "/projects/my-app",
    );
    expect(result).not.toContain("bash command 'cat");
  });

  test("truncates multi-line commands to 3 lines plus ellipsis", () => {
    const command = ["line1", "line2", "line3", "line4", "line5"].join("\n");
    const result = formatBashExternalDirectoryAskPrompt(
      command,
      ["/etc/passwd"],
      "/projects/my-app",
    );
    expect(result).toContain("  line1");
    expect(result).toContain("  line3");
    expect(result).not.toContain("line4");
    expect(result).toMatch(/… \(2 more lines\)/);
  });
});
