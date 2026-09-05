import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { identify, identifyPush } from "@libp2p/identify";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { base64ToBytes } from "@c/base64";
import createCommonNetwork, {
  type Network as CommonNetwork,
  type NetworkServiceFactories,
  type Peer,
} from "@c/backend/network";
import { registryServiceName } from "@c/backend/network/services/registry";
import {
  callingServiceName,
  createCalling,
} from "@v/backend/network/services/calling";
import {
  createDataTransfer,
  dataTransferServiceName,
} from "@v/backend/network/services/data-transfer";
import {
  createIdentity,
  identityServiceName,
} from "@v/backend/network/services/identity";
import {
  createMessaging,
  messagingServiceName,
} from "@v/backend/network/services/messaging";
import {
  isServiceEnabled,
  observeServiceEnabled,
} from "@v/backend/options/network-services";
import type { Options } from "@v/backend/options";

export type { NetworkUpdate } from "@c/backend/network";

export type Network = Omit<CommonNetwork, "createPeer"> & {
  connect(address: string, ...alternates: readonly string[]): Promise<Peer>;
};

const relayReservationTimeout = 5_000;

// Vessel adds one thing to the Common Network: the account's Options decide which
// services each peer may reach, while connected as well as at connection time. A
// peer which decides nothing of its own follows this peer's own configuration, the
// connection profile, which is what a stranger reaches.
export async function createNetwork(
  identitySeed: string,
  username: string,
  options: Options,
): Promise<Network> {
  const privateKey = await generateKeyPairFromSeed(
    "Ed25519",
    base64ToBytes(identitySeed),
  );
  // The profile is keyed by this peer's own ID, which is known before the Network
  // is, so a publication decision never reads a half-built one.
  const localPeerId = peerIdFromPrivateKey(privateKey).toString();

  function mayReach(peerId: string, serviceName: string): boolean {
    return isServiceEnabled(options, localPeerId, peerId, serviceName);
  }

  const serviceFactories: NetworkServiceFactories = {
    [identityServiceName]: () => createIdentity(username),
    [messagingServiceName]: () => createMessaging(),
    [dataTransferServiceName]: (peer) => createDataTransfer(peer),
    [callingServiceName]: () => createCalling(),
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
  }, serviceFactories, (peer, serviceName) => mayReach(peer.id, serviceName));
  const optionObservers = new Map<string, readonly (() => void)[]>();
  let shutdown: Promise<void> | undefined;

  function stopObserving(peerId: string): void {
    for (const stop of optionObservers.get(peerId) ?? []) stop();
    optionObservers.delete(peerId);
  }

  // Withholding Registry leaves a peer no way to learn what it may reach, which
  // bars it entirely, so the connection goes with it and stays refused while the
  // decision does.
  function applyPublication(peer: Peer): void {
    for (const serviceName of common.services()) {
      const enabled = mayReach(peer.id, serviceName);
      if (peer.hosts(serviceName) !== enabled) {
        common.publish(peer, serviceName, enabled);
      }
    }
    if (!mayReach(peer.id, registryServiceName)) {
      void peer.disconnect().catch(() => {});
    }
  }

  // The profile answers for every peer which decides nothing of its own, so a
  // change to it re-decides all of them at once.
  const stopObservingProfile = common.services().map((serviceName) =>
    observeServiceEnabled(options, localPeerId, serviceName, () => {
      for (const peer of common.connectedPeers()) applyPublication(peer);
    })
  );

  const stopObservingOptions = common.updates.subscribe((update) => {
    if (update.type === "connected") {
      const { peer } = update;
      optionObservers.set(
        peer.id,
        common.services().map((serviceName) =>
          observeServiceEnabled(options, peer.id, serviceName, () => applyPublication(peer))
        ),
      );
      applyPublication(peer);
    } else if (update.type === "disconnected") stopObserving(update.peerId);
  });

  return {
    ...common,
    async connect(address, ...alternates) {
      return await (await common.createPeer(address, ...alternates)).connect();
    },
    async close() {
      if (shutdown === undefined) {
        stopObservingOptions();
        for (const stop of stopObservingProfile) stop();
        for (const peerId of [...optionObservers.keys()]) stopObserving(peerId);
        shutdown = common.close();
      }
      await shutdown;
    },
  };
}
