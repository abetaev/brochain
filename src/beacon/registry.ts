export interface PeerRegistration {
  peerId: string;
  name: string;
  addresses: string[];
}

export interface DiscoveredPeer extends PeerRegistration {
  updatedAt: number;
}

const MAX_NAME_LENGTH = 64;
const MAX_ADDRESSES = 8;

export class PeerRegistry {
  private readonly peers = new Map<string, DiscoveredPeer>();

  constructor(
    private readonly ttlMilliseconds = 30_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  register(registration: PeerRegistration): DiscoveredPeer {
    const peerId = registration.peerId.trim();
    const name = registration.name.trim();
    const addresses = [...new Set(registration.addresses.filter((address) => address.includes("/webrtc")))];

    if (peerId.length === 0) {
      throw new Error("A peer id is required.");
    }

    if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
      throw new Error("A peer name must contain between 1 and 64 characters.");
    }

    if (addresses.length === 0 || addresses.length > MAX_ADDRESSES) {
      throw new Error("At least one WebRTC address is required.");
    }

    const peer: DiscoveredPeer = { peerId, name, addresses, updatedAt: this.now() };
    this.peers.set(peerId, peer);
    return peer;
  }

  list(excludedPeerId?: string): DiscoveredPeer[] {
    this.removeExpired();

    return [...this.peers.values()]
      .filter((peer) => peer.peerId !== excludedPeerId)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private removeExpired() {
    const cutoff = this.now() - this.ttlMilliseconds;

    for (const [peerId, peer] of this.peers) {
      if (peer.updatedAt < cutoff) {
        this.peers.delete(peerId);
      }
    }
  }
}
