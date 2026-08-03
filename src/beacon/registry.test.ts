import { describe, expect, it } from "vitest";
import { PeerRegistry } from "./registry";

describe("PeerRegistry", () => {
  it("lists other active peers and excludes expired registrations", () => {
    let now = 1_000;
    const registry = new PeerRegistry(100, () => now);

    registry.register({
      peerId: "peer-a",
      name: "Ada",
      addresses: ["/dns4/relay.example/tcp/9090/ws/p2p/relay/p2p-circuit/webrtc/p2p/peer-a"],
    });
    registry.register({
      peerId: "peer-b",
      name: "Bea",
      addresses: ["/dns4/relay.example/tcp/9090/ws/p2p/relay/p2p-circuit/webrtc/p2p/peer-b"],
    });

    expect(registry.list("peer-a")).toMatchObject([{ peerId: "peer-b", name: "Bea" }]);

    now = 1_101;
    expect(registry.list()).toEqual([]);
  });
});
