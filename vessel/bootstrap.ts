import type { Network, Peer } from "../common/network/index.ts";

export async function bootstrap(
  network: Network,
  ready?: () => Promise<void>,
): Promise<Peer> {
  const peer = await network.createPeer(defaultBeaconAddress());
  await peer.connect();
  await ready?.();
  return peer;
}

function defaultBeaconAddress(): string {
  const transportSecurity = window.location.protocol === "https:" ? "/tls" : "";
  return `/dns4/${window.location.hostname}/tcp/${import.meta.env.BEACON_RELAY_PORT}${transportSecurity}/ws`;
}
