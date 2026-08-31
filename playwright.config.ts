import { defineConfig } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = dirname(fileURLToPath(import.meta.url));
// Workflows run their own Vessel and Beacon on dedicated ports, so a peer left
// connected to a development server can never join the mesh under test.
const vesselPort = "5273";
const beaconRelayPort = "9190";
const address = `http://localhost:${vesselPort}`;

export default defineConfig({
  testDir: resolve(projectDirectory, "workflows"),
  testMatch: "**/*.test.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  globalSetup: resolve(projectDirectory, "workflows/coverage.ts"),
  use: { baseURL: address, browserName: "chromium", trace: "retain-on-failure" },
  webServer: {
    command: "node main.ts dev",
    env: { VESSEL_PORT: vesselPort, BEACON_RELAY_PORT: beaconRelayPort },
    url: address,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
