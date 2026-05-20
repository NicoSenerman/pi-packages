import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LifecycleManager, LifecycleRuntime } from "../../src/handlers/lifecycle.js";
import { SessionLifecycleHandler } from "../../src/handlers/lifecycle.js";

describe("SessionLifecycleHandler", () => {
  let runtime: LifecycleRuntime;
  let manager: LifecycleManager;
  let disposeNotifications: () => void;
  let unpublishService: () => void;
  let handler: SessionLifecycleHandler;

  const fakePi = { name: "fake-pi" };

  beforeEach(() => {
    runtime = {
      setSessionContext: vi.fn(),
      clearSessionContext: vi.fn(),
    };
    manager = {
      clearCompleted: vi.fn(),
      abortAll: vi.fn(),
      dispose: vi.fn(),
    };
    disposeNotifications = vi.fn<() => void>();
    unpublishService = vi.fn<() => void>();

    handler = new SessionLifecycleHandler(
      fakePi,
      runtime,
      manager,
      disposeNotifications,
      unpublishService,
    );
  });

  describe("handleSessionStart", () => {
    it("sets session context and clears completed agents", () => {
      const ctx = { cwd: "/some/path" };

      handler.handleSessionStart({}, ctx);

      expect(runtime.setSessionContext).toHaveBeenCalledWith(fakePi, ctx);
      expect(manager.clearCompleted).toHaveBeenCalled();
    });

    it("sets context before clearing completed", () => {
      const callOrder: string[] = [];
      (runtime.setSessionContext as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push("setSessionContext");
      });
      (manager.clearCompleted as ReturnType<typeof vi.fn>).mockImplementation(() => {
        callOrder.push("clearCompleted");
      });

      handler.handleSessionStart({}, {});

      expect(callOrder).toEqual(["setSessionContext", "clearCompleted"]);
    });
  });

  describe("handleSessionBeforeSwitch", () => {
    it("clears completed agents", () => {
      handler.handleSessionBeforeSwitch();

      expect(manager.clearCompleted).toHaveBeenCalled();
    });
  });

  describe("handleSessionShutdown", () => {
    it("calls all cleanup steps", async () => {
      await handler.handleSessionShutdown();

      expect(unpublishService).toHaveBeenCalled();
      expect(runtime.clearSessionContext).toHaveBeenCalled();
      expect(manager.abortAll).toHaveBeenCalled();
      expect(disposeNotifications).toHaveBeenCalled();
      expect(manager.dispose).toHaveBeenCalled();
    });

    it("calls cleanup in correct order", async () => {
      const callOrder: string[] = [];
      vi.mocked(unpublishService).mockImplementation(() => { callOrder.push("unpublishService"); });
      vi.mocked(runtime.clearSessionContext).mockImplementation(() => {
        callOrder.push("clearSessionContext");
      });
      vi.mocked(manager.abortAll).mockImplementation(() => {
        callOrder.push("abortAll");
      });
      vi.mocked(disposeNotifications).mockImplementation(() => { callOrder.push("disposeNotifications"); });
      vi.mocked(manager.dispose).mockImplementation(() => {
        callOrder.push("dispose");
      });

      await handler.handleSessionShutdown();

      expect(callOrder).toEqual([
        "unpublishService",
        "clearSessionContext",
        "abortAll",
        "disposeNotifications",
        "dispose",
      ]);
    });
  });
});
