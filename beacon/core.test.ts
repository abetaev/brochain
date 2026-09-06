// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

const dependency = vi.hoisted(() => ({ networkInterfaces: vi.fn() }));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  networkInterfaces: dependency.networkInterfaces,
}));

import { announcedAddresses } from "./core.ts";

function address(value: string, family: "IPv4" | "IPv6", internal = false) {
  return { address: value, family, internal, netmask: "", mac: "", cidr: null };
}

afterEach(() => {
  delete process.env.BEACON_HOST;
  dependency.networkInterfaces.mockReset();
});

describe("Beacon announced addresses", () => {
  it("announces a stated host at the address a browser arrives at", () => {
    process.env.BEACON_HOST = "bug.betaev.pub";

    expect(announcedAddresses(4173)).toEqual(["/dns4/bug.betaev.pub/tcp/443/tls/ws"]);
  });

  it("keeps the form a stated host has", () => {
    process.env.BEACON_HOST = "83.147.39.67";

    expect(announcedAddresses(4173)).toEqual(["/ip4/83.147.39.67/tcp/443/tls/ws"]);
  });

  it("announces every address this machine answers on at the port it listens on", () => {
    dependency.networkInterfaces.mockReturnValue({
      lo: [address("127.0.0.1", "IPv4", true)],
      world: [address("192.168.1.4", "IPv4"), address("fe80::1", "IPv6")],
      docker: [address("172.17.0.1", "IPv4")],
      down: undefined,
    });

    expect(announcedAddresses(5173)).toEqual([
      "/dns4/localhost/tcp/5173/ws",
      "/ip4/192.168.1.4/tcp/5173/ws",
      "/ip4/172.17.0.1/tcp/5173/ws",
    ]);
  });

  it("announces one address for a host answering on several interfaces", () => {
    dependency.networkInterfaces.mockReturnValue({
      world: [address("192.168.1.4", "IPv4")],
      bridge: [address("192.168.1.4", "IPv4")],
    });

    expect(announcedAddresses(5173)).toEqual([
      "/dns4/localhost/tcp/5173/ws",
      "/ip4/192.168.1.4/tcp/5173/ws",
    ]);
  });
});
