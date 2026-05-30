import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInputForSurface } from "#src/input-normalizer";
import type { PermissionsService } from "#src/service";
import {
  getPermissionsService,
  publishPermissionsService,
  unpublishPermissionsService,
} from "#src/service";
import type { PermissionCheckResult } from "#src/types";

// ── helpers ────────────────────────────────────────────────────────────────

function makeService(
  overrides: Partial<PermissionsService> = {},
): PermissionsService {
  return {
    checkPermission: vi.fn(),
    getToolPermission: vi.fn(),
    ...overrides,
  };
}

// ── globalThis accessor ────────────────────────────────────────────────────

describe("globalThis accessor", () => {
  afterEach(() => {
    unpublishPermissionsService();
  });

  it("returns undefined when nothing has been published", () => {
    expect(getPermissionsService()).toBeUndefined();
  });

  it("returns the published service", () => {
    const service = makeService();
    publishPermissionsService(service);
    expect(getPermissionsService()).toBe(service);
  });

  it("overwrites a previously published service", () => {
    const first = makeService();
    const second = makeService();
    publishPermissionsService(first);
    publishPermissionsService(second);
    expect(getPermissionsService()).toBe(second);
  });

  it("returns undefined after unpublish", () => {
    const service = makeService();
    publishPermissionsService(service);
    unpublishPermissionsService();
    expect(getPermissionsService()).toBeUndefined();
  });

  it("unpublish is safe to call when nothing was published", () => {
    expect(() => unpublishPermissionsService()).not.toThrow();
    expect(getPermissionsService()).toBeUndefined();
  });
});

// ── service adapter delegation ─────────────────────────────────────────────

describe("service adapter delegation", () => {
  afterEach(() => {
    unpublishPermissionsService();
  });

  const fakeResult: PermissionCheckResult = {
    toolName: "bash",
    state: "allow",
    matchedPattern: "git *",
    source: "bash",
    origin: "global",
  };

  it("checkPermission delegates surface and value through buildInputForSurface", () => {
    const checkPermission = vi.fn().mockReturnValue(fakeResult);
    const sessionRules = [
      {
        surface: "bash",
        pattern: "*",
        action: "allow" as const,
        layer: "session" as const,
        origin: "session" as const,
      },
    ];

    // Build the adapter the same way index.ts will
    const service = makeService({
      checkPermission(surface, value, agentName) {
        const input = buildInputForSurface(surface, value);
        return checkPermission(surface, input, agentName, sessionRules);
      },
    });

    publishPermissionsService(service);
    const retrieved = getPermissionsService()!;
    const result = retrieved.checkPermission("bash", "git push");

    expect(result).toBe(fakeResult);
    expect(checkPermission).toHaveBeenCalledWith(
      "bash",
      { command: "git push" },
      undefined,
      sessionRules,
    );
  });

  it("checkPermission passes agentName through", () => {
    const checkPermission = vi.fn().mockReturnValue(fakeResult);

    const service = makeService({
      checkPermission(surface, value, agentName) {
        const input = buildInputForSurface(surface, value);
        return checkPermission(surface, input, agentName, []);
      },
    });

    publishPermissionsService(service);
    getPermissionsService()!.checkPermission("skill", "my-skill", "Explore");

    expect(checkPermission).toHaveBeenCalledWith(
      "skill",
      { name: "my-skill" },
      "Explore",
      [],
    );
  });

  it("getToolPermission delegates to the permission manager", () => {
    const getToolPermissionFn = vi.fn(
      (_t: string, _a?: string): "deny" => "deny",
    );
    const service: PermissionsService = {
      checkPermission: vi.fn(),
      getToolPermission(toolName, agentName) {
        return getToolPermissionFn(toolName, agentName);
      },
    };

    publishPermissionsService(service);
    const result = getPermissionsService()!.getToolPermission(
      "bash",
      "Explore",
    );

    expect(result).toBe("deny");
    expect(getToolPermissionFn).toHaveBeenCalledWith("bash", "Explore");
  });

  it("getToolPermission works without agentName", () => {
    const getToolPermissionFn = vi.fn(
      (_t: string, _a?: string): "ask" => "ask",
    );
    const service: PermissionsService = {
      checkPermission: vi.fn(),
      getToolPermission(toolName, agentName) {
        return getToolPermissionFn(toolName, agentName);
      },
    };

    publishPermissionsService(service);
    const result = getPermissionsService()!.getToolPermission("write");

    expect(result).toBe("ask");
    expect(getToolPermissionFn).toHaveBeenCalledWith("write", undefined);
  });

  it("checkPermission uses empty object for unknown surfaces", () => {
    const checkPermission = vi.fn().mockReturnValue(fakeResult);

    const service = makeService({
      checkPermission(surface, value, agentName) {
        const input = buildInputForSurface(surface, value);
        return checkPermission(surface, input, agentName, []);
      },
    });

    publishPermissionsService(service);
    getPermissionsService()!.checkPermission("read", "/tmp/file");

    expect(checkPermission).toHaveBeenCalledWith("read", {}, undefined, []);
  });
});
