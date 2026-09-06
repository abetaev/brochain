import type { OptionObjects, Options } from "@v/backend/options";

declare module "@v/backend/options" {
  interface OptionSchemas {
    autoConnect: {
      peers: OptionObjects<string, {
        auto_connect: boolean;
      }>;
    };
  }
}

// Whether a peer is reached without being asked for. Nobody follows anybody here:
// the value is absent until something decides, and an absent one reaches nothing.
function decision(options: Options, peerId: string): boolean | undefined {
  return options.cat("peers").obj(peerId).get("auto_connect");
}

export function isAutoConnectEnabled(options: Options, peerId: string): boolean {
  return decision(options, peerId) ?? false;
}

export function decidesAutoConnect(options: Options, peerId: string): boolean {
  return decision(options, peerId) !== undefined;
}

export async function setAutoConnect(
  options: Options,
  peerId: string,
  enabled: boolean,
): Promise<void> {
  await options.cat("peers").obj(peerId).set("auto_connect", enabled);
}

export function observeAutoConnect(
  options: Options,
  peerId: string,
  listener: (enabled: boolean | undefined) => unknown,
): () => void {
  return options.cat("peers").obj(peerId).observe("auto_connect", listener);
}
