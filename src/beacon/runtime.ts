import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";
import type { ServerOptions } from "node:https";
import { PeerRegistry } from "./registry.ts";

export interface BeaconOptions {
  host: string;
  relayPort: number;
  announcePort?: number;
  tls?: ServerOptions;
}

export interface BeaconRuntime {
  relayMultiaddr: string;
  peers: PeerRegistry;
  stop(): Promise<void>;
}

export async function createBeacon(options: BeaconOptions): Promise<BeaconRuntime> {
  const announcePort = options.announcePort ?? options.relayPort;
  const tlsAddress = options.tls === undefined ? "" : "/tls";
  const relay = await createLibp2p({
    addresses: {
      listen: [`/ip4/0.0.0.0/tcp/${options.relayPort}/ws`],
      announce: [`/dns4/${options.host}/tcp/${announcePort}${tlsAddress}/ws`],
    },
    transports: [webSockets(options.tls === undefined ? undefined : { https: options.tls })],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: {
      denyDialMultiaddr: () => false,
    },
    services: {
      identify: identify(),
      relay: circuitRelayServer(),
    },
  });
  const relayMultiaddr = relay
    .getMultiaddrs()
    .map((address) => address.toString())
    .find((address) => address.includes("/ws"));

  if (relayMultiaddr === undefined) {
    await relay.stop();
    throw new Error("The beacon relay did not expose a WebSocket address.");
  }

  return {
    relayMultiaddr,
    peers: new PeerRegistry(),
    async stop() {
      await relay.stop();
    },
  };
}
