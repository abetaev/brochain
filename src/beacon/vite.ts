import type { Plugin } from "vite";
import { handleBeaconRequest } from "./http.ts";
import { createBeacon, type BeaconRuntime } from "./runtime.ts";

function relayPort(): number {
  const value = Number.parseInt(process.env.BEACON_RELAY_PORT ?? "9090", 10);
  return Number.isInteger(value) && value > 0 ? value : 9090;
}

export function beaconVitePlugin(): Plugin {
  let runtime: BeaconRuntime | undefined;
  let enabled = true;

  return {
    name: "brochain-beacon",
    configResolved(config) {
      enabled = config.mode !== "test";
    },
    configureServer(server) {
      if (!enabled) {
        return;
      }

      void createBeacon({
        host: process.env.BEACON_HOST ?? "localhost",
        relayPort: relayPort(),
      })
        .then((beacon) => {
          runtime = beacon;
        })
        .catch((error: unknown) => {
          server.config.logger.error(
            `Unable to start the beacon: ${error instanceof Error ? error.message : String(error)}`,
          );
        });

      server.middlewares.use((request, response, next) => {
        void (async () => {
          if (runtime === undefined) {
            if (request.url?.startsWith("/api/")) {
              response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
              response.end(JSON.stringify({ error: "Beacon is starting." }));
              return;
            }

            next();
            return;
          }

          if (!(await handleBeaconRequest(runtime, request, response))) {
            next();
          }
        })().catch(next);
      });

      server.httpServer?.once("close", () => {
        if (runtime !== undefined) {
          void runtime.stop();
        }
      });
    },
  };
}
