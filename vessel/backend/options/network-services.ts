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

export function isServiceEnabled(
  options: Options,
  peerId: string,
  serviceName: string,
): boolean {
  return options
    .cat("peers")
    .obj(peerId)
    .cat("services")
    .obj(serviceName)
    .get("enabled") !== false;
}
