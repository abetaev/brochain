import type { Network, Peer } from "../common/services/network/index.ts";

export async function bootstrap(
  network: Network,
  ready?: () => Promise<void>,
): Promise<Peer> {
  const created = await network.createPeer(defaultBeaconAddress());
  const peer = await created.connect();
  await ready?.();
  return peer;
}

function defaultBeaconAddress(): string {
  const transportSecurity = window.location.protocol === "https:" ? "/tls" : "";
  return `/dns4/${window.location.hostname}/tcp/${import.meta.env.BEACON_RELAY_PORT}${transportSecurity}/ws`;
}
