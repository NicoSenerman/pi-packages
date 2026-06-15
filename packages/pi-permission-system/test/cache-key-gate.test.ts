import { describe, expect, it, vi } from "vitest";

import { CacheKeyGate } from "#src/cache-key-gate";

describe("CacheKeyGate", () => {
  describe("runIfChanged", () => {
    it("runs the effect and returns its value when the key is new (null previous)", () => {
      const gate = new CacheKeyGate();
      const effect = vi.fn(() => "result");

      const result = gate.runIfChanged("key-a", effect);

      expect(effect).toHaveBeenCalledOnce();
      expect(result).toBe("result");
    });

    it("commits the key so a second call with the same key skips the effect", () => {
      const gate = new CacheKeyGate();
      const effect = vi.fn(() => "result");

      gate.runIfChanged("key-a", effect);
      const result = gate.runIfChanged("key-a", effect);

      expect(effect).toHaveBeenCalledOnce();
      expect(result).toBeUndefined();
    });

    it("runs the effect when the key changes", () => {
      const gate = new CacheKeyGate();
      const effect = vi.fn((n: number) => n);

      gate.runIfChanged("key-a", () => effect(1));
      const result = gate.runIfChanged("key-b", () => effect(2));

      expect(effect).toHaveBeenCalledTimes(2);
      expect(result).toBe(2);
    });

    it("returns undefined when the key is unchanged", () => {
      const gate = new CacheKeyGate();
      gate.runIfChanged("key-a", vi.fn());

      const result = gate.runIfChanged("key-a", vi.fn());

      expect(result).toBeUndefined();
    });

    it("does not commit the key if the effect throws", () => {
      const gate = new CacheKeyGate();
      const throwing = vi.fn(() => {
        throw new Error("oops");
      });
      const fallback = vi.fn(() => "ok");

      expect(() => gate.runIfChanged("key-a", throwing)).toThrow("oops");

      // Same key should run again since the first call threw
      gate.runIfChanged("key-a", fallback);
      expect(fallback).toHaveBeenCalledOnce();
    });
  });

  describe("reset", () => {
    it("re-arms the gate so the same key runs again on the next call", () => {
      const gate = new CacheKeyGate();
      const effect = vi.fn(() => "ok");

      gate.runIfChanged("key-a", effect);
      gate.reset();
      gate.runIfChanged("key-a", effect);

      expect(effect).toHaveBeenCalledTimes(2);
    });

    it("is idempotent when called on a fresh gate", () => {
      const gate = new CacheKeyGate();
      gate.reset();
      const effect = vi.fn(() => "ok");

      gate.runIfChanged("key-a", effect);

      expect(effect).toHaveBeenCalledOnce();
    });
  });
});
