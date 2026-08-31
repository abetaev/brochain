// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultBeaconAddress } from "./beacon.ts";

afterEach(() => vi.unstubAllGlobals());

describe("default Beacon address", () => {
  it("uses the current host and transport security", () => {
    vi.stubGlobal("window", {
      location: { hostname: "localhost", protocol: "http:" },
    });
    expect(defaultBeaconAddress()).toBe("/dns4/localhost/tcp/9090/ws");

    vi.stubGlobal("window", {
      location: { hostname: "vessel.example", protocol: "https:" },
    });
    expect(defaultBeaconAddress()).toBe(
      "/dns4/vessel.example/tcp/9090/tls/ws",
    );
  });
});
