import { describe, expect, it } from "vitest";
import {
  createRegistry,
  validateServiceNames,
} from "./registry.ts";

describe("Registry", () => {
  it("lists the current hosted service names", () => {
    const names = ["registry"];
    const registry = createRegistry(() => names);

    expect(registry.list()).toEqual(["registry"]);
    names.push("identity");
    expect(registry.list()).toEqual(["registry", "identity"]);
  });

  it("accepts only unique non-empty names that include Registry", () => {
    expect(validateServiceNames(["registry", "identity"]))
      .toEqual(["registry", "identity"]);

    for (const names of [
      [],
      ["identity"],
      ["registry", "registry"],
      ["registry", ""],
      ["registry", 1],
    ]) {
      expect(() => validateServiceNames(names)).toThrow("invalid service names");
    }
  });
});
