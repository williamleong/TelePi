import { describe, expect, it, vi } from "vitest";

import { createTelegramUIContext } from "../src/telegram-ui-context.js";

describe("createTelegramUIContext", () => {
  it("forwards notifications to the provided callback", () => {
    const notify = vi.fn();
    const ui = createTelegramUIContext({ notify });

    ui.notify("Something happened", "warning");

    expect(notify).toHaveBeenCalledWith("Something happened", "warning");
  });

  it("delegates interactive UI methods when handlers are provided", async () => {
    const ui = createTelegramUIContext({
      notify: vi.fn(),
      select: vi.fn().mockResolvedValue("b"),
      confirm: vi.fn().mockResolvedValue(true),
      input: vi.fn().mockResolvedValue("Bene"),
    });

    await expect(ui.select("Pick one", ["a", "b"]))
      .resolves.toBe("b");
    await expect(ui.confirm("Confirm", "Continue?"))
      .resolves.toBe(true);
    await expect(ui.input("Name"))
      .resolves.toBe("Bene");
  });

  it("fails clearly for unsupported interactive UI methods", async () => {
    const ui = createTelegramUIContext({ notify: vi.fn() });

    await expect(ui.select("Pick one", ["a", "b"]))
      .rejects.toThrow("TelePi does not yet support extension UI method 'select'.");
    await expect(ui.confirm("Confirm", "Continue?"))
      .rejects.toThrow("TelePi does not yet support extension UI method 'confirm'.");
    await expect(ui.input("Name"))
      .rejects.toThrow("TelePi does not yet support extension UI method 'input'.");
  });

  it("degrades unsupported custom UI to dialog fallbacks", async () => {
    const ui = createTelegramUIContext({ notify: vi.fn() });
    const factory = vi.fn();

    await expect(ui.custom(factory))
      .resolves.toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it("exposes setWorkingIndicator as a no-op for compatibility", () => {
    const ui = createTelegramUIContext({ notify: vi.fn() });

    expect(() => ui.setWorkingIndicator({ frames: ["●"], intervalMs: 250 })).not.toThrow();
    expect(() => ui.setWorkingIndicator()).not.toThrow();
  });

  it("exposes addAutocompleteProvider as a no-op for compatibility", () => {
    const ui = createTelegramUIContext({ notify: vi.fn() });
    const provider = vi.fn((current) => current);

    expect(() => ui.addAutocompleteProvider(provider)).not.toThrow();
  });

  it("exposes setHiddenThinkingLabel as a no-op for compatibility", () => {
    const ui = createTelegramUIContext({ notify: vi.fn() });

    expect(() => ui.setHiddenThinkingLabel("Thinking…")).not.toThrow();
    expect(() => ui.setHiddenThinkingLabel()).not.toThrow();
  });

  it("provides a plain-text theme shim for extension compatibility", () => {
    const ui = createTelegramUIContext({ notify: vi.fn() });

    expect(ui.theme.fg("accent", "hello")).toBe("hello");
    expect(ui.theme.bg("selectedBg", "hello")).toBe("hello");
    expect(ui.theme.bold("hello")).toBe("hello");
    expect(ui.theme.italic("hello")).toBe("hello");
    expect(ui.theme.underline("hello")).toBe("hello");
    expect(ui.theme.inverse("hello")).toBe("hello");
    expect(ui.theme.strikethrough("hello")).toBe("hello");
    expect(ui.theme.getFgAnsi("accent")).toBe("");
    expect(ui.theme.getBgAnsi("selectedBg")).toBe("");
    expect(ui.theme.getColorMode()).toBe("truecolor");
    expect(ui.theme.getThinkingBorderColor("medium")("hello")).toBe("hello");
    expect(ui.theme.getBashModeBorderColor()("hello")).toBe("hello");
  });
});
