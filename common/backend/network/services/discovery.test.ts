import { describe, expect, it } from "vitest";
import type { Peer } from "../peer.ts";
import {
  createDiscoveryHost,
  validateDiscoveredPeers,
  validateDiscoveryUpdate,
  type DiscoveryUpdate,
} from "./discovery.ts";

function peer(
  id: string,
  addresses: readonly string[],
  connected = true,
): Peer {
  return {
    id,
    addresses: () => addresses,
    isConnected: () => connected,
  } as Peer;
}

describe("Discovery", () => {
  it("lists connected addressed peers except the requester", () => {
    const requester = peer("requester", ["requester-address"]);
    const addressed = peer("addressed", ["first-address", "second-address"]);
    const addressless = peer("addressless", []);
    const disconnected = peer("disconnected", ["disconnected-address"], false);
    const host = createDiscoveryHost();
    host.peerChanged({ type: "connected", peer: requester });
    host.peerChanged({ type: "connected", peer: addressed });
    host.peerChanged({ type: "connected", peer: addressless });
    host.peerChanged({ type: "disconnected", peerId: disconnected.id });

    expect(host.service(requester).remote.list()).toEqual([{
      peerId: "addressed",
      addresses: ["first-address", "second-address"],
    }]);
  });

  it("publishes one directly applicable patch for each peer change", () => {
    const host = createDiscoveryHost();
    const requester = host.service(peer("requester", []));
    const other = host.service(peer("other", []));
    const requesterUpdates: DiscoveryUpdate[] = [];
    const otherUpdates: DiscoveryUpdate[] = [];
    requester.events.subscribe((update) => requesterUpdates.push(update));
    other.events.subscribe((update) => otherUpdates.push(update));

    host.peerChanged({ type: "addresses", peer: peer("requester", ["requester-address"]) });
    host.peerChanged({ type: "connected", peer: peer("changed", ["changed-address"]) });
    host.peerChanged({ type: "disconnected", peerId: peer("changed", []).id });

    expect(requesterUpdates).toEqual([
      {
        type: "set",
        peer: { peerId: "changed", addresses: ["changed-address"] },
      },
      { type: "remove", peerId: "changed" },
    ]);
    expect(otherUpdates).toEqual([
      {
        type: "set",
        peer: { peerId: "requester", addresses: ["requester-address"] },
      },
      {
        type: "set",
        peer: { peerId: "changed", addresses: ["changed-address"] },
      },
      { type: "remove", peerId: "changed" },
    ]);
  });

  it("validates snapshots and patches", () => {
    expect(validateDiscoveryUpdate({
      type: "set",
      peer: { peerId: "one", addresses: ["address"] },
    })).toEqual({
      type: "set",
      peer: { peerId: "one", addresses: ["address"] },
    });
    expect(validateDiscoveryUpdate({ type: "remove", peerId: "one" }))
      .toEqual({ type: "remove", peerId: "one" });
    expect(() => validateDiscoveredPeers({})).toThrow("invalid discovery list");
    expect(() => validateDiscoveredPeers([{ peerId: "", addresses: [] }]))
      .toThrow("invalid discovered peer");
    expect(() => validateDiscoveryUpdate({ type: "remove", peerId: "" }))
      .toThrow("invalid discovery update");
  });
});
