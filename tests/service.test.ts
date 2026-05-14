import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionsService } from "../src/service";
import {
  getPermissionsService,
  publishPermissionsService,
  unpublishPermissionsService,
} from "../src/service";

// ── helpers ────────────────────────────────────────────────────────────────

function makeService(
  overrides: Partial<PermissionsService> = {},
): PermissionsService {
  return {
    checkPermission: vi.fn(),
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
