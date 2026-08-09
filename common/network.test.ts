// @vitest-environment node

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify, identifyPush } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNetwork,
  type Network,
} from "./network.ts";
import type { PeerService } from "./rpc.ts";

interface EchoService extends PeerService<"echo"> {
  inspect(value: { payload: Uint8Array }): {
    caller: string;
    nested: { payload: Uint8Array };
  };
}

const networks: Network[] = [];

async function localNetwork(
  bootstrapAddresses: readonly string[] = [],
  bootstrapReady?: Parameters<typeof createNetwork>[2],
) {
  const node = await createLibp2p({
    start: false,
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0/ws"] },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), identifyPush: identifyPush() },
  });
  const result = await createNetwork(node, bootstrapAddresses, bootstrapReady);
  networks.push(result.network);
  const address = node.getMultiaddrs()[0]?.toString();
  if (address === undefined) throw new Error("Test peer did not expose an address.");
  return { ...result, address, node };
}

afterEach(async () => {
  await Promise.allSettled(networks.splice(0).map((network) => network.close()));
  vi.useRealTimers();
});

describe("peer network", () => {
  it("connects explicitly and emits remote-peer connection changes", async () => {
    const remote = await localNetwork();
    const local = await localNetwork();
    expect(() => local.registry.add(local.address)).toThrow("local peer");
    const inbound: string[] = [];
    remote.registry.subscribe((peer) => inbound.push(peer.id));
    const peer = local.registry.add(remote.address);
    const alternateAddress = remote.address.replace("/ip4/127.0.0.1", "/dns4/localhost");
    expect(local.registry.add(alternateAddress)).toBe(peer);
    expect(peer.addresses).toEqual([remote.address, alternateAddress]);
    const events: string[] = [];
    peer.subscribe((event) => events.push(event));

    expect(peer.isConnected()).toBe(false);
    await expect(
      peer.service<EchoService>("echo").inspect({ payload: new Uint8Array() }),
    ).rejects.toThrow("not connected");

    await peer.connect();
    expect(peer.isConnected()).toBe(true);
    expect(events).toEqual(["connected"]);
    await vi.waitFor(() => expect(inbound).toEqual([local.network.id]));
    await vi.waitFor(() => {
      const retained = remote.registry.peers.find(({ id }) => id === local.network.id);
      expect(retained?.addresses).toEqual([local.address]);
    });

    await remote.network.close();
    await vi.waitFor(() => expect(peer.isConnected()).toBe(false));
    expect(events).toEqual(["connected", "disconnected"]);
  });

  it("routes one typed RPC call per stream with bytes and authenticated caller identity", async () => {
    const remote = await localNetwork();
    const local = await localNetwork([remote.address]);
    remote.network.host((peer): EchoService => ({
      name: "echo",
      inspect: ({ payload }) => ({
        caller: peer.id,
        nested: { payload },
      }),
    }));

    await local.network.bootstrap();
    const peer = local.registry.peers[0];
    if (peer === undefined) throw new Error("Bootstrap peer was not retained.");
    const payload = new Uint8Array([0, 1, 127, 255]);
    const response = await peer.service<EchoService>("echo").inspect({ payload });

    expect(response.caller).toBe(local.network.id);
    expect([...response.nested.payload]).toEqual([...payload]);
    await expect(
      peer.service<EchoService>("echo").toString(),
    ).rejects.toThrow("Invalid RPC method");
  });

  it("authenticates a bootstrap address once and reuses its connection", async () => {
    const remote = await localNetwork();
    const addressWithoutPeerId = remote.address.replace(/\/p2p\/[^/]+$/, "");
    expect(addressWithoutPeerId).not.toContain("/p2p/");
    const local = await localNetwork([addressWithoutPeerId]);
    let connections = 0;
    remote.node.addEventListener("connection:open", () => {
      connections += 1;
    });

    await local.network.bootstrap();
    await local.network.bootstrap();

    await vi.waitFor(() => expect(connections).toBe(1));
    expect(local.registry.peers).toHaveLength(1);
    expect(local.registry.peers[0]?.addresses).toContain(remote.address);
  });

  it("waits for platform readiness only after a successful bootstrap", async () => {
    const remote = await localNetwork();
    const signals: AbortSignal[] = [];
    let connectedAtReadiness = false;
    let local: Awaited<ReturnType<typeof localNetwork>>;
    local = await localNetwork([remote.address], async (signal) => {
      signals.push(signal);
      connectedAtReadiness = local.registry.peers.some((peer) => peer.isConnected());
    });

    await local.network.bootstrap();
    await local.network.bootstrap();

    expect(connectedAtReadiness).toBe(true);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(false);
    await local.network.close();
    expect(signals[0]?.aborted).toBe(true);

    let calledAfterFailure = false;
    const failing = await localNetwork(["/invalid"], async () => {
      calledAfterFailure = true;
    });
    await expect(failing.network.bootstrap()).rejects.toThrow("bootstrap peer");
    expect(calledAfterFailure).toBe(false);
  });

  it("discovers hosted services and canonicalizes discovered peer addresses", async () => {
    const beacon = await localNetwork();
    beacon.network.host((peer) => beacon.registry.serve(peer));
    const first = await localNetwork([beacon.address]);
    const second = await localNetwork([beacon.address]);
    await first.network.bootstrap();
    await second.network.bootstrap();

    const beaconPeer = first.registry.peers.find(({ id }) => id === beacon.network.id);
    if (beaconPeer === undefined) throw new Error("Beacon was not retained.");
    await first.registry.discover();

    expect(beaconPeer.services).toEqual(["services", "peers"]);
    const discovered = first.registry.peers.find(({ id }) => id === second.network.id);
    expect(discovered).toBeDefined();
    expect(discovered?.isConnected()).toBe(false);
    expect(first.registry.add(discovered!.addresses[0]!)).toBe(discovered);
    expect(first.registry.peers.some(({ id }) => id === first.network.id)).toBe(false);
  });

  it("coalesces discovery and caches successful sweeps", async () => {
    const provider = await localNetwork();
    let calls = 0;
    let release: (() => void) | undefined;
    let fail = false;
    provider.network.host(() => ({
      name: "peers" as const,
      async discover(): Promise<readonly string[]> {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (fail) throw new Error("Discovery unavailable.");
        return [];
      },
    }));
    const local = await localNetwork([provider.address]);
    await local.network.bootstrap();

    const first = local.registry.discover();
    const concurrent = local.registry.discover();
    await vi.waitFor(() => expect(release).toBeDefined());
    release?.();
    await Promise.all([first, concurrent]);
    expect(calls).toBe(1);

    await local.registry.discover();
    expect(calls).toBe(1);

    const forced = local.registry.discover(true);
    await vi.waitFor(() => expect(calls).toBe(2));
    release?.();
    await forced;

    fail = true;
    const failedRefresh = local.registry.discover(true);
    await vi.waitFor(() => expect(calls).toBe(3));
    release?.();
    await failedRefresh;
    const retry = local.registry.discover();
    await vi.waitFor(() => expect(calls).toBe(4));
    release?.();
    await retry;
  });

  it("includes a peer that connects during a discovery sweep", async () => {
    const provider = await localNetwork();
    let release: (() => void) | undefined;
    provider.network.host(() => ({
      name: "peers" as const,
      async discover(): Promise<readonly string[]> {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return [];
      },
    }));
    const local = await localNetwork([provider.address]);
    await local.network.bootstrap();
    const discovery = local.registry.discover(true);
    await vi.waitFor(() => expect(release).toBeDefined());

    const newcomer = await localNetwork();
    newcomer.network.host((): EchoService => ({
      name: "echo",
      inspect: ({ payload }) => ({
        caller: newcomer.network.id,
        nested: { payload },
      }),
    }));
    await newcomer.registry.add(local.address).connect();
    const concurrent = local.registry.discover(true);
    release?.();
    await Promise.all([discovery, concurrent]);

    const peer = local.registry.peers.find(({ id }) => id === newcomer.network.id);
    expect(peer?.services).toEqual(["services", "echo"]);
  });

  it("does not cache a sweep when every connected provider fails", async () => {
    const provider = await localNetwork();
    let calls = 0;
    let returnedAddress = "";
    provider.network.host(() => ({
      name: "peers" as const,
      discover(): readonly string[] {
        calls += 1;
        return [returnedAddress];
      },
    }));
    const local = await localNetwork([provider.address]);
    returnedAddress = local.address;
    await local.network.bootstrap();

    await local.registry.discover();
    await local.registry.discover();

    expect(calls).toBe(2);
    expect(local.registry.peers.some(({ id }) => id === local.network.id)).toBe(false);
  });
});
