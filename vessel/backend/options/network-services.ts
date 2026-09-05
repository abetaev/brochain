import { registryServiceName } from "@c/backend/network/services/registry";
import type { OptionObjects, Options } from "@v/backend/options";

declare module "@v/backend/options" {
  interface OptionSchemas {
    networkServices: {
      peers: OptionObjects<string, {
        services: OptionObjects<string, {
          enabled: boolean;
        }>;
      }>;
    };
  }
}

// A peer's own decision about one service, absent while it follows the profile.
function serviceOverride(
  options: Options,
  peerId: string,
  serviceName: string,
): boolean | undefined {
  return options
    .cat("peers")
    .obj(peerId)
    .cat("services")
    .obj(serviceName)
    .get("enabled");
}

// The connection profile is this peer's own configuration, read by every peer
// which decides nothing of its own, and Registry is its only built-in default: a
// peer which cannot read a catalog is terminated before anyone could decide about
// it. This peer is configured like any other, so asking about it asks the profile.
export function isServiceEnabled(
  options: Options,
  localPeerId: string,
  peerId: string,
  serviceName: string,
): boolean {
  return serviceOverride(options, peerId, serviceName)
    ?? serviceOverride(options, localPeerId, serviceName)
    ?? serviceName === registryServiceName;
}

export function overridesService(
  options: Options,
  peerId: string,
  serviceName: string,
): boolean {
  return serviceOverride(options, peerId, serviceName) !== undefined;
}

export async function setServiceEnabled(
  options: Options,
  peerId: string,
  serviceName: string,
  enabled: boolean,
): Promise<void> {
  await options
    .cat("peers")
    .obj(peerId)
    .cat("services")
    .obj(serviceName)
    .set("enabled", enabled);
}

export async function clearServiceEnabled(
  options: Options,
  peerId: string,
  serviceName: string,
): Promise<void> {
  await options
    .cat("peers")
    .obj(peerId)
    .cat("services")
    .obj(serviceName)
    .unset("enabled");
}

// One object's property, because the decision reads two and a consumer which needs
// it observes the peer and the profile alike.
export function observeServiceEnabled(
  options: Options,
  peerId: string,
  serviceName: string,
  listener: (enabled: boolean | undefined) => unknown,
): () => void {
  return options
    .cat("peers")
    .obj(peerId)
    .cat("services")
    .obj(serviceName)
    .observe("enabled", listener);
}
