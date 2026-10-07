import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { VisionModelSelectorComponent } from "../../src/vision-model-selector.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

describe("VisionModelSelectorComponent", () => {
  it.each([20, 40, 60])("never renders wider than %i columns", (width) => {
    const component = new VisionModelSelectorComponent(
      theme,
      [{ provider: "provider-with-a-long-name", id: "model-with-a-long-name", name: "Long Vision Model", input: ["text", "image"], reasoning: true }],
      null,
      true,
      "high",
      true,
      () => {},
    );

    for (const line of component.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});
