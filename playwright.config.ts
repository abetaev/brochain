import { defineConfig } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = dirname(fileURLToPath(import.meta.url));
// Workflows run their own servers on dedicated ports, so a peer left connected to
// a development server can never join the mesh under test.
const vesselPort = "5273";
const address = `http://localhost:${vesselPort}`;

// A second Vessel is hosted without a relay, so a workflow can meet a default
// Beacon that answers nothing and reach the working one by address instead.
export const relaylessVesselAddress = "http://localhost:5373";
export const alternativeBeaconUrl = address;
export const alternativeBeaconAddress = `/dns4/localhost/tcp/${vesselPort}/ws`;

export default defineConfig({
  testDir: resolve(projectDirectory, "workflows"),
  testMatch: "**/*.test.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  globalSetup: resolve(projectDirectory, "workflows/coverage.ts"),
  use: {
    baseURL: address,
    browserName: "chromium",
    // A call needs a camera and a microphone, which the browser supplies
    // synthetically and grants without a prompt.
    launchOptions: {
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node main.ts dev",
      env: { VESSEL_PORT: vesselPort },
      url: address,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: "node main.ts dev",
      env: { VESSEL_PORT: "5373", BEACON_RELAY: "off" },
      url: relaylessVesselAddress,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
