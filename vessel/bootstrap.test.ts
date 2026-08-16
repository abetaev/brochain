// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Network, Peer } from "../common/network/index.ts";
import { bootstrap } from "./bootstrap.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function testPeer(connect: () => Promise<void>): Peer {
  return {
    id: "beacon",
    connect,
  } as Peer;
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
    const peer = testPeer(async () => {
      operations.push("connect");
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
    const createPeer = vi.fn(async () => testPeer(async () => {}));

    await bootstrap(testNetwork(createPeer));

    expect(createPeer).toHaveBeenCalledWith("/dns4/localhost/tcp/9090/ws");
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
    const connect = vi.fn(async () => {});
    const failure = new Error("Relay reservation failed.");

    await expect(
      bootstrap(testNetwork(async () => testPeer(connect)), async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(connect).toHaveBeenCalledOnce();
  });
});
