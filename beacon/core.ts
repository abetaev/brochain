import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { identify, identifyPush } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { type AddressInfo, connect, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import createNetwork from "../common/backend/network/index.ts";
import {
  createDiscoveryHost,
  discoveryServiceName,
} from "../common/backend/network/services/discovery.ts";
import { beaconIdentity } from "./identity.ts";

interface BeaconConfiguration {
  announce: readonly string[];
}

// A public address is reached over TLS on the port a browser assumes, because a
// deployment reached from outside terminates it in front of the relay.
const publicPort = 443;

// A relay whose host is stated is reached through something else — a proxy which
// terminates TLS, or a forwarded port — so it announces the address a browser arrives
// at rather than the one it listens on, which is the address every circuit address a
// peer derives is built from. Left unstated, it answers on every address this machine
// has, at the port it listens on.
export function announcedAddresses(port: number): readonly string[] {
  const publicHost = process.env.BEACON_HOST;
  if (publicHost !== undefined) return [`${hostAddress(publicHost)}/tcp/${publicPort}/tls/ws`];

  const local = Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => address.family === "IPv4" && !address.internal)
    .map((address) => address.address);
  return ["localhost", ...new Set(local)].map((host) => `${hostAddress(host)}/tcp/${port}/ws`);
}

// A relay is reached by whichever of its addresses the dialing peer can resolve,
// so each announced host keeps the form it actually has.
function hostAddress(host: string): string {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? `/ip4/${host}` : `/dns4/${host}`;
}

// The transport insists on creating its own listener, so the relay is given a
// private one on loopback and reached through the server people already open.
async function privatePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  probe.close();
  await once(probe, "close");
  return port;
}

function requestLines(request: IncomingMessage): string {
  const headers: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    headers.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
  }
  return `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${
    headers.join("\r\n")
  }\r\n\r\n`;
}

// A WebSocket is an HTTP upgrade, so the public server hands the ones it does not
// want to the relay verbatim and then carries bytes between the two.
function forwardUpgrade(port: number) {
  return (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const relay = connect(port, "127.0.0.1");
    const disconnect = () => {
      relay.destroy();
      socket.destroy();
    };
    // A destroyed socket can report more than once, so these stay attached.
    relay.on("error", disconnect);
    socket.on("error", disconnect);
    relay.once("close", disconnect);
    socket.once("close", disconnect);
    relay.once("connect", () => {
      relay.write(requestLines(request));
      if (head.length > 0) relay.write(head);
      relay.pipe(socket);
      socket.pipe(relay);
    });
  };
}

export async function createBeacon(configuration: BeaconConfiguration) {
  const relayPort = await privatePort();
  const discovery = createDiscoveryHost();
  const network = await createNetwork({
    privateKey: await beaconIdentity(),
    addresses: {
      listen: [`/ip4/127.0.0.1/tcp/${relayPort}/ws`],
      announce: [...configuration.announce],
    },
    transports: [
      webSockets(),
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
  }, {
    [discoveryServiceName]: discovery.service,
  });
  network.updates.subscribe(discovery.peerChanged);
  return { ...network, handleUpgrade: forwardUpgrade(relayPort) };
}
