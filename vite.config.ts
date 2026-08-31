import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VitePWA } from "vite-plugin-pwa";
import solid from "vite-plugin-solid";
import { createBeaconPlugin } from "./beacon/dev.ts";

const projectDirectory = dirname(fileURLToPath(import.meta.url));
const commonDirectory = resolve(projectDirectory, "common");
const vesselDirectory = resolve(projectDirectory, "vessel");
const frontendDirectory = resolve(vesselDirectory, "frontend");
const iconPath = resolve(frontendDirectory, "icon.svg");

export default defineConfig(({ command, mode }) => {
  const configuredRelayPort = command === "serve"
    ? process.env.BEACON_RELAY_PORT ?? "9090"
    : process.env.BEACON_PUBLIC_RELAY_PORT ?? process.env.BEACON_RELAY_PORT ?? "9090";
  const relayPort = Number(configuredRelayPort);
  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65_535) {
    throw new Error("Beacon relay port must be a valid port number.");
  }

  return {
    root: mode === "test" ? projectDirectory : frontendDirectory,
    server: { port: Number(process.env.VESSEL_PORT ?? 5173), strictPort: true },
    cacheDir: resolve(projectDirectory, "node_modules/.vite"),
    publicDir: false,
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
      assetsInlineLimit: (filePath) => filePath === iconPath ? false : undefined,
      rolldownOptions: {
        output: {
          strictExecutionOrder: true,
          assetFileNames: (asset) => asset.names.includes("icon.svg")
            ? "icon.svg"
            : "assets/[name]-[hash][extname]",
          codeSplitting: {
            includeDependenciesRecursively: true,
            groups: [
              {
                name: "password-strength",
                test: /node_modules[\\/]@zxcvbn-ts[\\/]/,
                maxSize: 499_000,
                priority: 2,
              },
              {
                name: "peer-networking",
                test: /node_modules[\\/](?:@chainsafe|@libp2p|libp2p)[\\/]/,
                maxSize: 499_000,
                priority: 1,
              },
            ],
          },
        },
      },
    },
    plugins: mode === "test" ? [] : [
      solid(),
      createBeaconPlugin(),
      VitePWA({
        registerType: "autoUpdate",
        includeManifestIcons: false,
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
          globPatterns: ["**/*.{js,wasm,css,html,svg}"],
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        },
      }),
    ],
    test: {
      coverage: {
        provider: "v8",
        enabled: true,
        all: true,
        reportsDirectory: resolve(projectDirectory, "coverage/unit"),
        include: ["common/**/*.ts", "vessel/**/*.ts", "beacon/**/*.ts", "main.ts"],
        exclude: ["**/*.test.ts"],
        reporter: ["text-summary", "html"],
      },
      include: [
        resolve(projectDirectory, "common/**/*.test.ts"),
        resolve(vesselDirectory, "backend/**/*.test.ts"),
        resolve(frontendDirectory, "**/*.test.ts"),
        resolve(projectDirectory, "beacon/**/*.test.ts"),
        resolve(projectDirectory, "main.test.ts"),
      ],
    },
  };
});
