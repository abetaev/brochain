// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Network, Peer } from "../common/services/network/index.ts";
import { bootstrap } from "./bootstrap.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function testPeer(connect?: () => Promise<Peer>): Peer {
  const peer = {
    id: "beacon",
  } as Peer;
  return Object.assign(peer, { connect: connect ?? (async () => peer) });
}

function testNetwork(createPeer: (address: string) => Promise<Peer>): Network {
  return { createPeer } as Network;
}

describe("default Beacon bootstrap", () => {
  it("creates, connects, and waits for a secure Beacon in order", async () => {
    vi.stubGlobal("window", {
      location: { hostname: "vessel.example", protocol: "https:" },
    });
    const operations: string[] = [];
    let peer: Peer;
    peer = testPeer(async () => {
      operations.push("connect");
      return peer;
    });
    const network = testNetwork(async (address) => {
      operations.push(`create:${address}`);
      return peer;
    });
    const ready = vi.fn(async () => {
      operations.push("ready");
    });

    await expect(bootstrap(network, ready)).resolves.toBe(peer);
    expect(operations).toEqual([
      "create:/dns4/vessel.example/tcp/9090/tls/ws",
      "connect",
      "ready",
    ]);
  });

  it("uses an unsecured WebSocket address for an HTTP Vessel", async () => {
    vi.stubGlobal("window", {
      location: { hostname: "localhost", protocol: "http:" },
    });
    const createPeer = vi.fn(async () => testPeer());

    await bootstrap(testNetwork(createPeer));

    expect(createPeer).toHaveBeenCalledWith("/dns4/localhost/tcp/9090/ws");
  });

  it("returns the active Peer selected while connecting", async () => {
    vi.stubGlobal("window", {
      location: { hostname: "localhost", protocol: "http:" },
    });
    const connected = testPeer();
    const created = testPeer(async () => connected);

    await expect(bootstrap(testNetwork(async () => created))).resolves.toBe(connected);
  });

  it("does not continue when Peer creation fails", async () => {
    vi.stubGlobal("window", {
      location: { hostname: "localhost", protocol: "http:" },
    });
    const failure = new Error("Beacon unavailable.");
    const ready = vi.fn(async () => {});
    const network = testNetwork(async () => {
      throw failure;
    });

    await expect(bootstrap(network, ready)).rejects.toBe(failure);
    expect(ready).not.toHaveBeenCalled();
  });

  it("does not report readiness after connection failure", async () => {
    vi.stubGlobal("window", {
      location: { hostname: "localhost", protocol: "http:" },
    });
    const failure = new Error("Connection failed.");
    const ready = vi.fn(async () => {});
    const peer = testPeer(async () => {
      throw failure;
    });

    await expect(bootstrap(testNetwork(async () => peer), ready)).rejects.toBe(failure);
    expect(ready).not.toHaveBeenCalled();
  });

  it("propagates readiness failure after connecting", async () => {
    vi.stubGlobal("window", {
      location: { hostname: "localhost", protocol: "http:" },
    });
    let peer: Peer;
    const connect = vi.fn(async () => peer);
    peer = testPeer(connect);
    const failure = new Error("Relay reservation failed.");

    await expect(
      bootstrap(testNetwork(async () => peer), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(connect).toHaveBeenCalledOnce();
  });
});
