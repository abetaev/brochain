import type { OptionObjects, Options } from "@v/backend/options";

declare module "@v/backend/options" {
  interface OptionSchemas {
    localPeer: {
      peers: OptionObjects<string, {
        auto_accept_connections: boolean;
      }>;
    };
  }
}

// Settings describing this peer's own behaviour are kept under the local peer
// ID, so the local peer is configured the same way every remote one is.

// A peer connecting is not trusted automatically, so an absent setting is off.
export function autoAcceptsConnections(options: Options, localPeerId: string): boolean {
  return options.cat("peers").obj(localPeerId).get("auto_accept_connections") === true;
}

export async function setAutoAcceptConnections(
  options: Options,
  localPeerId: string,
  accept: boolean,
): Promise<void> {
  await options.cat("peers").obj(localPeerId).set("auto_accept_connections", accept);
}

export function observeAutoAcceptConnections(
  options: Options,
  localPeerId: string,
  listener: (accept: boolean) => unknown,
): () => void {
  return options
    .cat("peers")
    .obj(localPeerId)
    .observe("auto_accept_connections", (accept) => listener(accept === true));
}
