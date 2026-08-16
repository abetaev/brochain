import { describe, expect, it } from "vitest";
import type { Peer } from "../peer.ts";
import { createDiscovery } from "./discovery.ts";

const peer = { id: "peer" } as Peer;

describe("Discovery gateway", () => {
  it("accepts only arrays of address strings", async () => {
    const service = createDiscovery(() => []);
    if (service.gateway === undefined) throw new Error("Discovery gateway is missing.");
    const valid = service.gateway(peer, {
      list: async () => ["/ip4/127.0.0.1/tcp/1/ws/p2p/peer"],
    });
    await expect(valid.list()).resolves.toEqual([
      "/ip4/127.0.0.1/tcp/1/ws/p2p/peer",
    ]);

    const invalid = service.gateway(peer, {
      list: async () => [1] as unknown as readonly string[],
    });
    await expect(invalid.list()).rejects.toThrow("invalid discovery addresses");
  });
});
