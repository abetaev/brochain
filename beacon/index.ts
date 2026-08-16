import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { identify, identifyPush } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";
import type { ServerOptions } from "node:https";
import { createDiscovery, createNetwork } from "../common/network/index.ts";

interface BeaconConfiguration {
  host: string;
  relayPort: number;
  announcePort?: number;
  tls?: ServerOptions;
}

export async function createBeacon(configuration: BeaconConfiguration) {
  const announcePort = configuration.announcePort ?? configuration.relayPort;
  const tlsAddress = configuration.tls === undefined ? "" : "/tls";
  const node = await createLibp2p({
    start: false,
    addresses: {
      listen: [`/ip4/0.0.0.0/tcp/${configuration.relayPort}/ws`],
      announce: [`/dns4/${configuration.host}/tcp/${announcePort}${tlsAddress}/ws`],
    },
    transports: [
      webSockets(configuration.tls === undefined ? undefined : { https: configuration.tls }),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      identifyPush: identifyPush(),
      relay: circuitRelayServer({
        reservations: {
          maxReservations: Infinity,
          applyDefaultLimit: false,
        },
      }),
    },
  });

  try {
    const network = await createNetwork(node);
    network.host(createDiscovery(() => network.connectedPeers()));
    return network;
  } catch (error) {
    await node.stop();
    throw error;
  }
}
