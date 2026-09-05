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

export default defineConfig(({ mode }) => {
  const vesselPort = Number(process.env.VESSEL_PORT ?? 5173);
  // A development build installs like any other, so its name says which of the
  // two an installed application is.
  const applicationName = mode === "development" ? "brochain [dev]" : "brochain";

  return {
    root: mode === "test" ? projectDirectory : frontendDirectory,
    server: {
      host: true,
      port: vesselPort,
      strictPort: true,
    },
    cacheDir: resolve(projectDirectory, "node_modules/.vite"),
    // The icons a manifest names must keep the names it names them by, and the
    // root a public directory would default to differs under test.
    publicDir: resolve(frontendDirectory, "public"),
    resolve: {
      alias: {
        "@c": commonDirectory,
        "@v": vesselDirectory,
      },
    },
    build: {
      outDir: resolve(projectDirectory, "dist"),
      emptyOutDir: true,
      rolldownOptions: {
        output: {
          strictExecutionOrder: true,
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
      createBeaconPlugin(vesselPort),
      VitePWA({
        registerType: "autoUpdate",
        includeManifestIcons: false,
        manifest: {
          name: applicationName,
          short_name: applicationName,
          description: "Private peer-to-peer communication.",
          display: "standalone",
          theme_color: "#0f172a",
          background_color: "#ffffff",
          // A browser offers installation only for an application whose icons it
          // can raster at both sizes it needs.
          icons: [
            { src: "icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "icon-512.png", sizes: "512x512", type: "image/png" },
            { src: "icon.svg", sizes: "any", type: "image/svg+xml" },
          ],
        },
        workbox: {
          globPatterns: ["**/*.{js,wasm,css,html,svg,png}"],
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        },
        // Development serves what an installation needs, because the address
        // another device opens is the development one. Its worker is registered
        // rather than used: development globs run over the folder below, and a
        // navigation fallback would answer every reload from the install.
        devOptions: {
          enabled: true,
          suppressWarnings: true,
          navigateFallbackAllowlist: [],
          // Workflows run two servers at once, and a shared worker folder is
          // written and read by both.
          resolveTempFolder: () => resolve(projectDirectory, "dev", `pwa-${vesselPort}`),
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
