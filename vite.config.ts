import { defineConfig } from "vitest/config";
import { VitePWA } from "vite-plugin-pwa";
import solid from "vite-plugin-solid";
import { beaconVitePlugin } from "./src/beacon/vite.ts";

export default defineConfig({
  plugins: [
    solid(),
    beaconVitePlugin(),
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
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
