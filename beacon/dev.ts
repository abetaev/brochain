import type { Plugin } from "vite";
import { createBeacon, localHosts } from "./core.ts";

// A Vessel host without a relay is a deployment of its own: the page finds no
// Beacon at its own origin and asks for another. Refusing the upgrade says so at
// once, where an unanswered one would look like a Beacon that is merely slow.
const providesRelay = process.env.BEACON_RELAY !== "off";

function report(message: string, error: unknown): string {
  return `${message}: ${error instanceof Error ? error.message : String(error)}`;
}

// Development serves Vessel and the relay from one origin, so the page reaches
// its Beacon wherever it was opened and one forwarded port carries both.
export function createBeaconPlugin(port: number): Plugin {
  return {
    name: "brochain-beacon",
    async configureServer(server) {
      let relay: Awaited<ReturnType<typeof createBeacon>> | undefined;
      try {
        if (providesRelay) relay = await createBeacon({ hosts: localHosts(), port });
      } catch (error) {
        server.config.logger.error(report("Unable to start the beacon", error));
        return;
      }

      server.httpServer?.on("upgrade", (request, socket, head) => {
        // Vite claims its own development sockets from a listener of its own and
        // leaves every other upgrade alone.
        const protocol = request.headers["sec-websocket-protocol"];
        if (protocol === "vite-hmr" || protocol === "vite-ping") return;
        if (relay === undefined) {
          // A socket this server answered is its responsibility until it closes,
          // and a reset one must not reach the process as an unhandled error.
          socket.on("error", () => socket.destroy());
          socket.end("HTTP/1.1 501 Not Implemented\r\n\r\n");
          return;
        }
        relay.handleUpgrade(request, socket, head);
      });

      server.httpServer?.once("close", async () => {
        try {
          await relay?.close();
        } catch (error) {
          server.config.logger.error(report("Unable to stop the beacon", error));
        }
      });
    },
  };
}
