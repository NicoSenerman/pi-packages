import { expect, test } from "vitest";
import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";
import { getPermissionSystemStatus } from "#src/status";

test("Permission-system status shows BACH by default, yolo when yoloMode is on", () => {
  // Our fork defaults to BACH (orchestrator) mode: a fresh session shows the
  // BACH label + prompt + gate without the user picking a mode first.
  expect(getPermissionSystemStatus(DEFAULT_EXTENSION_CONFIG)).toBe("BACH");
  // When config.yoloMode is on (upstream's enable flag), show "YOLO".
  expect(
    getPermissionSystemStatus({ ...DEFAULT_EXTENSION_CONFIG, yoloMode: true }),
  ).toBe("YOLO");
});
