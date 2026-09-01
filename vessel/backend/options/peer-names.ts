import type { OptionObjects, Options } from "@v/backend/options";

declare module "@v/backend/options" {
  interface OptionSchemas {
    peerNames: {
      peers: OptionObjects<string, {
        display_name: string;
      }>;
    };
  }
}

const maximumLength = 64;

export function displayName(options: Options, peerId: string): string | undefined {
  return options.cat("peers").obj(peerId).get("display_name");
}

export async function setDisplayName(
  options: Options,
  peerId: string,
  name: string,
): Promise<void> {
  const chosen = name.trim();
  if (chosen.length === 0 || chosen.length > maximumLength) {
    throw new Error(`A name must be 1 to ${maximumLength} characters.`);
  }
  await options.cat("peers").obj(peerId).set("display_name", chosen);
}

export async function clearDisplayName(options: Options, peerId: string): Promise<void> {
  await options.cat("peers").obj(peerId).unset("display_name");
}

export function observeDisplayName(
  options: Options,
  peerId: string,
  listener: (name: string | undefined) => unknown,
): () => void {
  return options.cat("peers").obj(peerId).observe("display_name", listener);
}
