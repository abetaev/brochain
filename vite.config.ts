import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VitePWA } from "vite-plugin-pwa";
import solid from "vite-plugin-solid";
import { createBeaconPlugin } from "./beacon/dev.ts";

const projectDirectory = dirname(fileURLToPath(import.meta.url));
const commonDirectory = resolve(projectDirectory, "common");
const vesselDirectory = resolve(projectDirectory, "vessel");

export default defineConfig(({ command, mode }) => {
  const configuredRelayPort = command === "serve"
    ? process.env.BEACON_RELAY_PORT ?? "9090"
    : process.env.BEACON_PUBLIC_RELAY_PORT ?? process.env.BEACON_RELAY_PORT ?? "9090";
  const relayPort = Number(configuredRelayPort);
  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65_535) {
    throw new Error("Beacon relay port must be a valid port number.");
  }

  return {
    root: vesselDirectory,
    cacheDir: resolve(projectDirectory, "node_modules/.vite"),
    publicDir: resolve(projectDirectory, "public"),
    define: {
      "import.meta.env.BEACON_RELAY_PORT": JSON.stringify(String(relayPort)),
    },
    resolve: {
      alias: {
        "@c": commonDirectory,
        "@v": vesselDirectory,
      },
    },
    build: {
      outDir: resolve(projectDirectory, "dist"),
      emptyOutDir: true,
    },
    plugins: mode === "test" ? [] : [
      solid(),
      createBeaconPlugin(),
      VitePWA({
        registerType: "autoUpdate",
        manifest: {
          name: "brochain",
          short_name: "brochain",
          description: "Private peer-to-peer communication.",
          display: "standalone",
          theme_color: "#0f172a",
          background_color: "#ffffff",
          icons: [
            {
              src: "icon.svg",
              sizes: "any",
              type: "image/svg+xml",
              purpose: "any",
            },
          ],
        },
        workbox: {
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        },
      }),
    ],
    test: {
      include: [
        resolve(projectDirectory, "common/**/*.test.ts"),
        resolve(vesselDirectory, "**/*.test.ts"),
        resolve(projectDirectory, "beacon/**/*.test.ts"),
        resolve(projectDirectory, "main.test.ts"),
      ],
    },
  };
});
