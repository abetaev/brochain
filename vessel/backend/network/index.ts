import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { identify, identifyPush } from "@libp2p/identify";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { base64ToBytes } from "@c/base64";
import createCommonNetwork, {
  type NetworkServiceFactories,
  type Peer,
} from "@c/backend/network";
import {
  createDataTransfer,
  dataTransferServiceName,
  type DataTransfer,
} from "@v/backend/network/services/data-transfer";
import {
  createIdentity,
  identityServiceName,
} from "@v/backend/network/services/identity";
import {
  createMessaging,
  messagingServiceName,
  type Messaging,
} from "@v/backend/network/services/messaging";
import {
  isServiceEnabled,
  observeServiceEnabled,
} from "@v/backend/options/network-services";
import type { Options } from "@v/backend/options";
import type { Channel, Signals } from "@v/backend/signals";

export type NetworkUpdate = Readonly<
  | {
    type: "set";
    peer: Peer;
    changed: "connection" | "addresses" | "services";
  }
  | { type: "remove"; peerId: string }
>;

export interface Network {
  readonly id: string;
  readonly updates: Channel<NetworkUpdate>;
  connect(address: string, ...alternates: readonly string[]): Promise<Peer>;
  connectedPeers(): readonly Peer[];
  services(): readonly string[];
  messaging(): Messaging;
  dataTransfer(): DataTransfer;
  close(): Promise<void>;
}

const relayReservationTimeout = 5_000;

export async function createNetwork(
  identitySeed: string,
  username: string,
  options: Options,
  signals: Signals,
): Promise<Network> {
  const privateKey = await generateKeyPairFromSeed(
    "Ed25519",
    base64ToBytes(identitySeed),
  );
  const messaging = createMessaging(signals);
  const dataTransfer = createDataTransfer(signals);
  const serviceFactories: NetworkServiceFactories = {
    [identityServiceName]: () => ({ rpc: createIdentity(username) }),
    [messagingServiceName]: messaging.factory,
    [dataTransferServiceName]: dataTransfer.factory,
  };
  const common = await createCommonNetwork({
    privateKey,
    addresses: { listen: ["/p2p-circuit", "/webrtc"] },
    transports: [
      webSockets(),
      webRTC(),
      circuitRelayTransport({ reservationCompletionTimeout: relayReservationTimeout }),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: { denyDialMultiaddr: () => false },
    services: {
      identify: identify(),
      identifyPush: identifyPush({ debounce: 0 }),
    },
  }, serviceFactories, (peer, serviceName) =>
    isServiceEnabled(options, peer.id, serviceName)
  );
  const updates = signals.channel<NetworkUpdate>({}, "updates");
  const optionObservers = new Map<string, readonly (() => void)[]>();
  let shutdown: Promise<void> | undefined;

  const stopNetworkUpdates = common.subscribe((peer, event) => {
    if (event === "connected") {
      optionObservers.set(peer.id, common.services().map((serviceName) =>
        observeServiceEnabled(options, peer.id, serviceName, (enabled) => {
          common.publish(peer, serviceName, enabled);
        })
      ));
      updates.publish({ type: "set", peer, changed: "connection" });
      return;
    }
    if (event === "disconnected") {
      stopObservingPeer(peer.id);
      updates.publish({ type: "remove", peerId: peer.id });
      return;
    }
    updates.publish({
      type: "set",
      peer,
      changed: event === "addresses" ? "addresses" : "services",
    });
  });

  function stopObservingPeer(peerId: string): void {
    for (const stop of optionObservers.get(peerId) ?? []) stop();
    optionObservers.delete(peerId);
  }

  return {
    id: common.id,
    updates,
    async connect(address, ...alternates) {
      return await (await common.createPeer(address, ...alternates)).connect();
    },
    connectedPeers: common.connectedPeers,
    services: common.services,
    messaging: () => messaging,
    dataTransfer: () => dataTransfer,
    async close() {
      if (shutdown === undefined) {
        stopNetworkUpdates();
        for (const peerId of optionObservers.keys()) stopObservingPeer(peerId);
        shutdown = common.close();
      }
      await shutdown;
    },
  };
}

export function defaultBeaconAddress(): string {
  const tls = window.location.protocol === "https:" ? "/tls" : "";
  return `/dns4/${window.location.hostname}/tcp/${import.meta.env.BEACON_RELAY_PORT}${tls}/ws`;
}
