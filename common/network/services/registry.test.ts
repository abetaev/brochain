import { describe, expect, it } from "vitest";
import type { Peer } from "../peer.ts";
import { createRegistryService } from "./registry.ts";

const peer = { id: "peer" } as Peer;

describe("Registry gateway", () => {
  it("accepts only unique non-empty names that include Registry", async () => {
    const service = createRegistryService(() => []);
    if (service.gateway === undefined) throw new Error("Registry gateway is missing.");
    const valid = service.gateway(peer, {
      list: async () => ["registry", "identity"],
    });
    await expect(valid.list()).resolves.toEqual(["registry", "identity"]);

    for (const names of [
      [],
      ["identity"],
      ["registry", "registry"],
      ["registry", ""],
      ["registry", 1],
    ]) {
      const invalid = service.gateway(peer, {
        list: async () => names as unknown as readonly string[],
      });
      await expect(invalid.list()).rejects.toThrow("invalid service names");
    }
  });
});
