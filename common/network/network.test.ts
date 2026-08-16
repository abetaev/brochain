// @vitest-environment node

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify, identifyPush } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDiscovery,
  createNetwork,
  discoveryServiceName,
  registryServiceName,
  type DiscoveryService,
  type Network,
  type PeerService,
  type RegistryService,
  type ServiceDefinition,
} from "./index.ts";

interface EchoRpc extends PeerService<"echo"> {
  inspect(value: { payload: Uint8Array }): {
    caller: string;
    nested: { payload: Uint8Array };
  };
}

interface EchoService extends ServiceDefinition<EchoRpc> {}

const networks: Network[] = [];

async function localNetwork() {
  const node = await createLibp2p({
    start: false,
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0/ws"] },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), identifyPush: identifyPush() },
  });
  const network = await createNetwork(node);
  networks.push(network);
  const address = node.getMultiaddrs()[0]?.toString();
  if (address === undefined) throw new Error("Test peer did not expose an address.");
  return { network, address, node };
}

function echo(): EchoService {
  return {
    name: "echo",
    serve(peer): EchoRpc {
      return {
        name: "echo",
        inspect: ({ payload }) => ({
          caller: peer.id,
          nested: { payload },
        }),
      };
    },
  };
}

function addressedPeer(address: string): string | undefined {
  return multiaddr(address).getComponents()
    .filter(({ name }) => name === "p2p")
    .at(-1)?.value;
}

afterEach(async () => {
  await Promise.allSettled(networks.splice(0).map((network) => network.close()));
});

describe("network peers", () => {
  it("canonicalizes identity-bearing addresses without connecting", async () => {
    const remote = await localNetwork();
    const other = await localNetwork();
    const local = await localNetwork();
    const alternate = remote.address.replace("/ip4/127.0.0.1", "/dns4/localhost");

    const peer = await local.network.createPeer(remote.address, alternate);
    expect(peer.id).toBe(remote.network.id);
    expect(peer.addresses()).toEqual([remote.address, alternate]);
    expect(peer.isConnected()).toBe(false);
    expect(local.network.connectedPeers()).toEqual([]);
    expect(await local.network.createPeer(alternate)).toBe(peer);

    await expect(local.network.createPeer(local.address)).rejects.toThrow("local peer");
    await expect(
      local.network.createPeer(remote.address, other.address),
    ).rejects.toThrow("different peers");
  });

  it("authenticates an identity-less address once and returns its connected Peer", async () => {
    const remote = await localNetwork();
    const local = await localNetwork();
    const addressWithoutPeerId = remote.address.replace(/\/p2p\/[^/]+$/, "");
    let connections = 0;
    remote.node.addEventListener("connection:open", () => {
      connections += 1;
    });

    const peer = await local.network.createPeer(addressWithoutPeerId);
    const retained = await local.network.createPeer(addressWithoutPeerId);

    expect(retained).toBe(peer);
    expect(peer.id).toBe(remote.network.id);
    expect(peer.addresses()).toContain(remote.address);
    expect(peer.isConnected()).toBe(true);
    expect(local.network.connectedPeers()).toEqual([peer]);
    await vi.waitFor(() => expect(connections).toBe(1));
  });

  it("connects explicitly and reports peer and network topology changes", async () => {
    const remote = await localNetwork();
    const local = await localNetwork();
    const topology: string[] = [];
    const inbound: string[] = [];
    local.network.subscribe((peer) => topology.push(`${peer.id}:${peer.isConnected()}`));
    remote.network.subscribe((peer) => inbound.push(`${peer.id}:${peer.isConnected()}`));
    const peer = await local.network.createPeer(remote.address);
    const events: string[] = [];
    peer.subscribe((event) => events.push(event));

    await peer.connect();

    expect(peer.isConnected()).toBe(true);
    expect(events).toEqual(["connected"]);
    expect(topology).toEqual([`${remote.network.id}:true`]);
    await vi.waitFor(() => expect(inbound).toEqual([`${local.network.id}:true`]));
    await vi.waitFor(() => {
      const connected = remote.network.connectedPeers()
        .find(({ id }) => id === local.network.id);
      expect(connected?.addresses()).toContain(local.address);
    });

    await remote.network.close();
    await vi.waitFor(() => expect(peer.isConnected()).toBe(false));
    expect(events).toEqual(["connected", "disconnected"]);
    expect(topology).toEqual([
      `${remote.network.id}:true`,
      `${remote.network.id}:false`,
    ]);
  });
});

describe("network services", () => {
  it("hosts the mandatory Registry and routes authenticated typed RPC with bytes", async () => {
    const remote = await localNetwork();
    const local = await localNetwork();
    remote.network.host(echo());
    const peer = await local.network.createPeer(remote.address);
    await peer.connect();

    const names = await peer.service<RegistryService>(registryServiceName).list();
    const payload = new Uint8Array([0, 1, 127, 255]);
    const response = await peer.service<EchoService>("echo").inspect({ payload });

    expect(names).toEqual([registryServiceName, "echo"]);
    expect(response.caller).toBe(local.network.id);
    expect([...response.nested.payload]).toEqual([...payload]);
    await expect(
      peer.service<EchoService>("echo").toString(),
    ).rejects.toThrow("Invalid RPC method");
  });

  it("validates hosted definitions and rejects duplicate names", async () => {
    const local = await localNetwork();
    local.network.host(echo());

    expect(() => local.network.host(echo())).toThrow("already hosted");
    expect(() => local.network.host({
      name: registryServiceName,
      serve: () => ({ name: registryServiceName }),
    })).toThrow("already hosted");
    expect(() => local.network.host({
      name: "",
      serve: () => ({ name: "" }),
    })).toThrow("must have a name");
  });

  it("lets a peer-local gateway wrap the raw remote service", async () => {
    interface GreetingRpc extends PeerService<"greeting"> {
      greet(): string;
    }
    interface Greeting {
      greet(): Promise<string>;
    }
    interface GreetingService extends ServiceDefinition<GreetingRpc, Greeting> {}

    const remote = await localNetwork();
    const local = await localNetwork();
    remote.network.host({
      name: "greeting",
      serve: () => ({ name: "greeting", greet: () => "hello" }),
    } satisfies ServiceDefinition<GreetingRpc>);
    local.network.host({
      name: "greeting",
      serve: () => ({ name: "greeting", greet: () => "local" }),
      gateway: (_peer, raw) => ({
        greet: async () => `${await raw.greet()} through gateway`,
      }),
    } satisfies GreetingService);
    const peer = await local.network.createPeer(remote.address);
    await peer.connect();

    await expect(peer.service<GreetingService>("greeting").greet())
      .resolves.toBe("hello through gateway");
  });
});

describe("common Discovery", () => {
  it("lists connected peers except the requester without connecting returned peers", async () => {
    const beacon = await localNetwork();
    beacon.network.host(createDiscovery(beacon.network.connectedPeers));
    const first = await localNetwork();
    const second = await localNetwork();
    const firstBeacon = await first.network.createPeer(beacon.address);
    const secondBeacon = await second.network.createPeer(beacon.address);
    await Promise.all([firstBeacon.connect(), secondBeacon.connect()]);
    await vi.waitFor(() => expect(beacon.network.connectedPeers()).toHaveLength(2));

    expect(
      await firstBeacon.service<RegistryService>(registryServiceName).list(),
    ).toEqual([registryServiceName, discoveryServiceName]);
    const addresses = await firstBeacon
      .service<DiscoveryService>(discoveryServiceName)
      .list();
    expect(addresses.some((address) => addressedPeer(address) === first.network.id)).toBe(false);
    const secondAddress = addresses.find(
      (address) => addressedPeer(address) === second.network.id,
    );
    expect(secondAddress).toBeDefined();

    const discovered = await first.network.createPeer(secondAddress!);
    expect(discovered.id).toBe(second.network.id);
    expect(discovered.isConnected()).toBe(false);
  });
});
