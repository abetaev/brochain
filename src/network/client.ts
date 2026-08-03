import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { identify } from "@libp2p/identify";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import type { Stream } from "@libp2p/interface";
import { createLibp2p, type Libp2p } from "libp2p";
import type { AccountSecrets } from "../accounts/types";
import { base64ToBytes, bytesToBase64, CHAT_PROTOCOL, decodePacket, encodePacket, type PeerPacket } from "./protocol";

export interface BeaconConfiguration {
  relayMultiaddr: string;
}

export interface DiscoveredPeer {
  peerId: string;
  name: string;
  addresses: string[];
}

export interface IncomingPeerPacket {
  peerId: string;
  packet: PeerPacket;
}

export interface PeerNetworkController {
  onPacket(listener: (packet: IncomingPeerPacket) => void): () => void;
  start(secrets: AccountSecrets, accountName: string): Promise<void>;
  stop(): Promise<void>;
  peers(): Promise<DiscoveredPeer[]>;
  connect(peer: DiscoveredPeer): Promise<void>;
  connectDirect(address: string): Promise<DiscoveredPeer>;
  sendText(peer: DiscoveredPeer, text: string): Promise<PeerPacket>;
  sendFile(peer: DiscoveredPeer, file: File): Promise<PeerPacket>;
}

interface PeerListResponse {
  peers: DiscoveredPeer[];
}

interface BeaconResponse {
  relayMultiaddr: string;
}

const encoder = new TextEncoder();

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function readStream(stream: Stream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;

  for await (const chunk of stream) {
    const bytes = chunk instanceof Uint8Array ? chunk : chunk.subarray();
    chunks.push(bytes);
    length += bytes.byteLength;
  }

  const result = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
}

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
    throw new Error(body?.error ?? `Beacon request failed with ${response.status}.`);
  }

  return response.json() as Promise<T>;
}

export class PeerNetwork implements PeerNetworkController {
  private node: Libp2p | undefined;
  private heartbeat: number | undefined;
  private readonly listeners = new Set<(packet: IncomingPeerPacket) => void>();
  private ownPeerId: string | undefined;
  private accountName: string | undefined;

  onPacket(listener: (packet: IncomingPeerPacket) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(secrets: AccountSecrets, accountName: string): Promise<void> {
    await this.stop();
    const beacon = await responseJson<BeaconResponse>(await fetch("/api/beacon"));
    const privateKey = await generateKeyPairFromSeed("Ed25519", base64ToBytes(secrets.identitySeed));
    const node = await createLibp2p({
      privateKey,
      addresses: {
        listen: ["/p2p-circuit", "/webrtc"],
      },
      transports: [webSockets(), webRTC(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionGater: {
        denyDialMultiaddr: () => false,
      },
      services: {
        identify: identify(),
      },
    });

    await node.handle(CHAT_PROTOCOL, async (stream, connection) => {
      try {
        const packet = decodePacket(await readStream(stream));

        for (const listener of this.listeners) {
          listener({ peerId: connection.remotePeer.toString(), packet });
        }
      } finally {
        await stream.close();
      }
    });

    try {
      await node.dial(multiaddr(beacon.relayMultiaddr));
      await this.waitForWebRtcAddress(node);
    } catch (error) {
      await node.stop();
      throw error;
    }

    this.node = node;
    this.ownPeerId = secrets.peerId;
    this.accountName = accountName;
    await this.publishPresence();
    this.heartbeat = window.setInterval(() => {
      void this.publishPresence();
    }, 10_000);
  }

  async stop(): Promise<void> {
    if (this.heartbeat !== undefined) {
      window.clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }

    if (this.node !== undefined) {
      await this.node.stop();
      this.node = undefined;
    }

    this.ownPeerId = undefined;
    this.accountName = undefined;
  }

  async peers(): Promise<DiscoveredPeer[]> {
    if (this.ownPeerId === undefined) {
      return [];
    }

    const url = new URL("/api/peers", window.location.origin);
    url.searchParams.set("exclude", this.ownPeerId);
    const response = await responseJson<PeerListResponse>(await fetch(url));
    return response.peers;
  }

  async connect(peer: DiscoveredPeer): Promise<void> {
    const node = this.requireNode();
    const address = peer.addresses[0];

    if (address === undefined) {
      throw new Error("This peer has no usable WebRTC address.");
    }

    await node.dial(multiaddr(address));
  }

  async connectDirect(address: string): Promise<DiscoveredPeer> {
    const trimmedAddress = address.trim();

    if (trimmedAddress.length === 0) {
      throw new Error("Enter a peer multiaddress.");
    }

    const connection = await this.requireNode().dial(multiaddr(trimmedAddress));

    return {
      peerId: connection.remotePeer.toString(),
      name: connection.remotePeer.toString(),
      addresses: [trimmedAddress],
    };
  }

  async sendText(peer: DiscoveredPeer, text: string): Promise<PeerPacket> {
    const trimmedText = text.trim();

    if (trimmedText.length === 0) {
      throw new Error("Enter a message.");
    }

    const packet: PeerPacket = {
      type: "text",
      id: crypto.randomUUID(),
      sentAt: new Date().toISOString(),
      text: trimmedText,
    };
    await this.sendPacket(peer, packet);
    return packet;
  }

  async sendFile(peer: DiscoveredPeer, file: File): Promise<PeerPacket> {
    const packet: PeerPacket = {
      type: "file",
      id: crypto.randomUUID(),
      sentAt: new Date().toISOString(),
      name: file.name,
      mediaType: file.type || "application/octet-stream",
      data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
    };
    await this.sendPacket(peer, packet);
    return packet;
  }

  private async sendPacket(peer: DiscoveredPeer, packet: PeerPacket): Promise<void> {
    const node = this.requireNode();
    const address = peer.addresses[0];

    if (address === undefined) {
      throw new Error("This peer has no usable WebRTC address.");
    }

    const stream = await node.dialProtocol(multiaddr(address), CHAT_PROTOCOL);
    stream.send(encodePacket(packet));
    await stream.close();
  }

  private async waitForWebRtcAddress(node: Libp2p): Promise<void> {
    const timeout = Date.now() + 10_000;

    while (Date.now() < timeout) {
      if (this.webRtcAddresses(node).length > 0) {
        return;
      }

      await delay(100);
    }

    throw new Error("The beacon relay did not provide a WebRTC address.");
  }

  private async publishPresence(): Promise<void> {
    const node = this.requireNode();

    if (this.ownPeerId === undefined || this.accountName === undefined) {
      return;
    }

    const response = await fetch("/api/peers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        peerId: this.ownPeerId,
        name: this.accountName,
        addresses: this.webRtcAddresses(node),
      }),
    });

    await responseJson(response);
  }

  private webRtcAddresses(node: Libp2p): string[] {
    return node
      .getMultiaddrs()
      .map((address) => address.toString())
      .filter((address) => address.includes("/webrtc"));
  }

  private requireNode(): Libp2p {
    if (this.node === undefined) {
      throw new Error("Peer networking is not running.");
    }

    return this.node;
  }
}
