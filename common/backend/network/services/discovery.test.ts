import { describe, expect, it } from "vitest";
import type { Peer } from "../peer.ts";
import {
  createDiscovery,
  validateDiscoveryAddresses,
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
    const discovery = createDiscovery(
      requester,
      () => [requester, addressed, addressless, disconnected],
    );

    expect(discovery.list()).toEqual(["first-address", "second-address"]);
  });

  it("accepts only arrays of address strings", () => {
    expect(validateDiscoveryAddresses(["/ip4/127.0.0.1/tcp/1/ws/p2p/peer"]))
      .toEqual(["/ip4/127.0.0.1/tcp/1/ws/p2p/peer"]);
    expect(() => validateDiscoveryAddresses([1])).toThrow("invalid discovery addresses");
  });
});
