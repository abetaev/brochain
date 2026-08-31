import { describe, expect, it, vi } from "vitest";
import {
  createRegistry,
  validateServiceNames,
} from "./registry.ts";

describe("Registry", () => {
  it("lists the current hosted service names", () => {
    const names = ["registry"];
    const registry = createRegistry(() => names);

    expect(registry.remote.list()).toEqual(["registry"]);
    names.push("identity");
    expect(registry.remote.list()).toEqual(["registry", "identity"]);
  });

  it("publishes an announced catalog and refuses an invalid one", () => {
    const registry = createRegistry(() => []);
    const announced = vi.fn();
    registry.events.subscribe(announced);

    registry.remote.announce(["registry", "identity"]);

    expect(announced).toHaveBeenCalledWith({ services: ["registry", "identity"] });
    expect(() => registry.remote.announce(["registry", "registry"]))
      .toThrow("invalid service names");
    expect(announced).toHaveBeenCalledOnce();
  });

  it("accepts only unique non-empty service names", () => {
    expect(validateServiceNames(["registry", "identity"]))
      .toEqual(["registry", "identity"]);
    expect(validateServiceNames([])).toEqual([]);
    expect(validateServiceNames(["identity"])).toEqual(["identity"]);

    for (const names of [
      ["registry", "registry"],
      ["registry", ""],
      ["registry", 1],
    ]) {
      expect(() => validateServiceNames(names)).toThrow("invalid service names");
    }
  });
});
