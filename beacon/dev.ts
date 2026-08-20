import type { Plugin } from "vite";
import { createBeacon } from "./core.ts";

function configuredRelayPort(): number {
  const value = Number(process.env.BEACON_RELAY_PORT ?? 9090);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("BEACON_RELAY_PORT must be a valid port number.");
  }
  return value;
}

export function createBeaconPlugin(): Plugin {
  let beacon: Awaited<ReturnType<typeof createBeacon>> | undefined;

  return {
    name: "brochain-beacon",
    async configureServer(server) {
      try {
        beacon = await createBeacon({
          host: process.env.BEACON_HOST ?? "localhost",
          relayPort: configuredRelayPort(),
        });
      } catch (error) {
        server.config.logger.error(
          `Unable to start the beacon: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      server.httpServer?.once("close", async () => {
        try {
          await beacon?.close();
        } catch (error) {
          server.config.logger.error(
            `Unable to stop the beacon: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    },
  };
}
