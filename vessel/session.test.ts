// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Network, Peer } from "../common/network/index.ts";
import type { Roster } from "./services/roster.ts";

const dependencies = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  createLibp2p: vi.fn(),
  createNetwork: vi.fn(),
  createRoster: vi.fn(),
  generateKeyPairFromSeed: vi.fn(),
}));

vi.mock("@chainsafe/libp2p-noise", () => ({ noise: () => ({}) }));
vi.mock("@chainsafe/libp2p-yamux", () => ({ yamux: () => ({}) }));
vi.mock("@libp2p/circuit-relay-v2", () => ({ circuitRelayTransport: () => ({}) }));
vi.mock("@libp2p/crypto/keys", () => ({
  generateKeyPairFromSeed: dependencies.generateKeyPairFromSeed,
}));
vi.mock("@libp2p/identify", () => ({ identify: () => ({}), identifyPush: () => ({}) }));
vi.mock("@libp2p/webrtc", () => ({ webRTC: () => ({}) }));
vi.mock("@libp2p/websockets", () => ({ webSockets: () => ({}) }));
vi.mock("libp2p", () => ({ createLibp2p: dependencies.createLibp2p }));
vi.mock("../common/network/index.ts", () => ({ createNetwork: dependencies.createNetwork }));
vi.mock("@/bootstrap", () => ({ bootstrap: dependencies.bootstrap }));
vi.mock("@/services/roster", () => ({ createRoster: dependencies.createRoster }));

import { createSession } from "./session.ts";

interface TestRuntime {
  readonly beacon: Peer;
  readonly network: Network & {
    host: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  readonly node: {
    stop: ReturnType<typeof vi.fn>;
  };
  readonly roster: Roster;
}

let runtime: TestRuntime;

beforeEach(() => {
  dependencies.bootstrap.mockReset();
  dependencies.createLibp2p.mockReset();
  dependencies.createNetwork.mockReset();
  dependencies.createRoster.mockReset();
  dependencies.generateKeyPairFromSeed.mockReset();

  const beacon = {
    id: "beacon",
    isConnected: vi.fn(() => true),
  } as unknown as Peer;
  const network = {
    id: "local",
    host: vi.fn(),
    close: vi.fn(async () => {}),
  } as unknown as TestRuntime["network"];
  const node = {
    stop: vi.fn(async () => {}),
  };
  const roster = {
    list: vi.fn(async () => []),
    getPeer: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => {}),
  } as unknown as Roster;
  runtime = { beacon, network, node, roster };

  dependencies.generateKeyPairFromSeed.mockResolvedValue({});
  dependencies.createLibp2p.mockResolvedValue(node);
  dependencies.createNetwork.mockResolvedValue(network);
  dependencies.bootstrap.mockResolvedValue(beacon);
  dependencies.createRoster.mockReturnValue(roster);
});

function openSession(closeAccountSession = vi.fn(async () => {})) {
  return createSession(
    async () => ({ username: "alice", identitySeed: "AA==" }),
    closeAccountSession,
  );
}

describe("Session access and lifetime", () => {
  it("lazily memoizes concurrent Network, Roster, and peer Storage access", async () => {
    const session = await openSession();
    expect(dependencies.createLibp2p).not.toHaveBeenCalled();

    const [firstNetwork, secondNetwork, firstRoster, secondRoster] = await Promise.all([
      session.network(),
      session.network(),
      session.roster(),
      session.roster(),
    ]);

    expect(firstNetwork).toBe(runtime.network);
    expect(secondNetwork).toBe(runtime.network);
    expect(firstRoster).toBe(runtime.roster);
    expect(secondRoster).toBe(runtime.roster);
    expect(dependencies.createLibp2p).toHaveBeenCalledOnce();
    expect(dependencies.createNetwork).toHaveBeenCalledOnce();
    expect(dependencies.bootstrap).toHaveBeenCalledOnce();
    expect(dependencies.createRoster).toHaveBeenCalledOnce();
    expect(runtime.network.host.mock.calls.map(([service]) => service.name))
      .toEqual(["identity", "messaging"]);
    expect(runtime.network.host.mock.invocationCallOrder.at(-1))
      .toBeLessThan(dependencies.bootstrap.mock.invocationCallOrder[0]!);

    const peer = { id: "remote" } as Peer;
    expect(session.storage(peer)).toBe(session.storage(peer));

    await session.close();
  });

  it("returns an offline Network, reports bootstrap failure, and retries on access", async () => {
    dependencies.bootstrap
      .mockRejectedValueOnce(new Error("Beacon unavailable."))
      .mockResolvedValueOnce(runtime.beacon);
    const session = await openSession();

    await expect(session.network()).resolves.toBe(runtime.network);
    expect(session.bootstrapError()).toBe("Beacon unavailable.");
    expect(runtime.network.close).not.toHaveBeenCalled();

    await expect(session.network()).resolves.toBe(runtime.network);
    expect(dependencies.bootstrap).toHaveBeenCalledTimes(2);
    expect(session.bootstrapError()).toBeUndefined();

    await session.close();
  });

  it("retries bootstrap when the previously connected Beacon disconnects", async () => {
    const session = await openSession();

    await session.network();
    expect(dependencies.bootstrap).toHaveBeenCalledOnce();

    const isConnected = runtime.beacon.isConnected as ReturnType<typeof vi.fn>;
    isConnected.mockReturnValue(false);
    await expect(session.roster()).resolves.toBe(runtime.roster);

    expect(dependencies.bootstrap).toHaveBeenCalledTimes(2);
    expect(dependencies.createNetwork).toHaveBeenCalledOnce();
    expect(dependencies.createRoster).toHaveBeenCalledOnce();

    await session.close();
  });

  it("closes safely while lazy Network initialization is still pending", async () => {
    let finishNetwork: ((network: Network) => void) | undefined;
    dependencies.createNetwork.mockImplementation(async () =>
      await new Promise<Network>((resolve) => {
        finishNetwork = resolve;
      })
    );
    const closeAccountSession = vi.fn(async () => {});
    const session = await openSession(closeAccountSession);
    const access = session.network();
    await vi.waitFor(() => expect(finishNetwork).toBeDefined());

    const firstClose = session.close();
    const secondClose = session.close();
    finishNetwork?.(runtime.network);

    await expect(Promise.all([firstClose, secondClose])).resolves.toEqual([undefined, undefined]);
    await expect(access).rejects.toThrow("Session is closed");
    expect(runtime.network.close).toHaveBeenCalledOnce();
    expect(closeAccountSession).toHaveBeenCalledOnce();
    expect(dependencies.bootstrap).not.toHaveBeenCalled();
    expect(() => session.storage({ id: "remote" } as Peer)).toThrow("Session is closed");
  });

  it("closes Account access even when Network shutdown fails", async () => {
    const failure = new Error("Network shutdown failed.");
    runtime.network.close.mockRejectedValueOnce(failure);
    const closeAccountSession = vi.fn(async () => {});
    const session = await openSession(closeAccountSession);
    await session.network();

    await expect(session.close()).rejects.toBe(failure);
    expect(closeAccountSession).toHaveBeenCalledOnce();
    await expect(session.close()).rejects.toBe(failure);
    expect(runtime.network.close).toHaveBeenCalledOnce();
    expect(closeAccountSession).toHaveBeenCalledOnce();
  });
});
