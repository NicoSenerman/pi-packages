import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	registerChildSession,
	unregisterChildSession,
} from "#src/lifecycle/permission-bridge";

// ── Service stub ─────────────────────────────────────────────────────────────

const PERMISSION_SERVICE_KEY = Symbol.for(
	"@gotgenes/pi-permission-system:service",
);

const mockRegister = vi.fn<(key: string, info: { parentSessionId?: string; agentName: string }) => void>();
const mockUnregister = vi.fn<(key: string) => void>();

const stubService = {
	registerSubagentSession: mockRegister,
	unregisterSubagentSession: mockUnregister,
};

function publishService(): void {
	(globalThis as Record<symbol, unknown>)[PERMISSION_SERVICE_KEY] = stubService;
}

function removeService(): void {
	// eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- test teardown
	delete (globalThis as Record<symbol, unknown>)[PERMISSION_SERVICE_KEY];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
	mockRegister.mockReset();
	mockUnregister.mockReset();
});

afterEach(() => {
	removeService();
});

describe("registerChildSession", () => {
	it("delegates to registerSubagentSession when the service is present", () => {
		publishService();

		registerChildSession("/sessions/child-abc", {
			agentName: "Explore",
			parentSessionId: "parent-session-123",
		});

		expect(mockRegister).toHaveBeenCalledOnce();
		expect(mockRegister).toHaveBeenCalledWith("/sessions/child-abc", {
			agentName: "Explore",
			parentSessionId: "parent-session-123",
		});
	});

	it("passes undefined parentSessionId through", () => {
		publishService();

		registerChildSession("/sessions/child-xyz", {
			agentName: "general-purpose",
			parentSessionId: undefined,
		});

		expect(mockRegister).toHaveBeenCalledWith("/sessions/child-xyz", {
			agentName: "general-purpose",
			parentSessionId: undefined,
		});
	});

	it("is a no-op when the service is absent", () => {
		// No publishService() call — service not installed

		expect(() =>
			registerChildSession("/sessions/child-abc", { agentName: "Explore" }),
		).not.toThrow();

		expect(mockRegister).not.toHaveBeenCalled();
	});
});

describe("unregisterChildSession", () => {
	it("delegates to unregisterSubagentSession when the service is present", () => {
		publishService();

		unregisterChildSession("/sessions/child-abc");

		expect(mockUnregister).toHaveBeenCalledOnce();
		expect(mockUnregister).toHaveBeenCalledWith("/sessions/child-abc");
	});

	it("is a no-op when the service is absent", () => {
		// No publishService() call — service not installed

		expect(() => unregisterChildSession("/sessions/child-abc")).not.toThrow();

		expect(mockUnregister).not.toHaveBeenCalled();
	});
});
