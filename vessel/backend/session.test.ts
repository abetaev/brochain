// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Network as CommonNetwork,
  Peer,
  Services,
} from "@c/backend/network";
import type { Network } from "@v/backend/network";
import type { Storage } from "@v/backend/storage";
import type { Options } from "./options";

const dependencies = vi.hoisted(() => ({
  createNetwork: vi.fn(),
  createOptions: vi.fn(),
  createStorage: vi.fn(),
}));

vi.mock("@v/backend/network", () => ({ createNetwork: dependencies.createNetwork }));
vi.mock("@v/backend/options", () => ({ createOptions: dependencies.createOptions }));
vi.mock("@v/backend/storage", () => ({ createStorage: dependencies.createStorage }));

import { createSession } from "./session.ts";

let commonNetwork: CommonNetwork;
let network: Network;
let options: Options;
let storage: Storage;
let serviceSettings: Map<string, boolean>;

beforeEach(() => {
  commonNetwork = { id: "local" } as CommonNetwork;
  network = {
    id: commonNetwork.id,
    access: vi.fn(async () => commonNetwork),
    provide: vi.fn(async () => {}),
    bootstrapError: vi.fn(),
    close: vi.fn(async () => {}),
  };
  serviceSettings = new Map();
  options = {
    cat: vi.fn((_category: string) => ({
      obj: (peerId: string) => ({
        cat: (_nested: string) => ({
          obj: (serviceName: string) => ({
            get: (_property: string) => serviceSettings.get(
              `${peerId}/${serviceName}`,
            ),
          }),
        }),
      }),
    })),
  } as unknown as Options;
  const service = {};
  const volatilePeer = { service: vi.fn(() => ({})) };
  const persistentPeer = { service: vi.fn(() => service) };
  storage = {
    persistent: { peer: vi.fn(() => persistentPeer) },
    peer: vi.fn(() => volatilePeer),
    close: vi.fn(async () => {}),
  } as unknown as Storage;
  dependencies.createNetwork.mockReset().mockResolvedValue(network);
  dependencies.createOptions.mockReset().mockResolvedValue(options);
  dependencies.createStorage.mockReset().mockResolvedValue(storage);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function openSession(closeAccountSession = vi.fn(async () => {})) {
  return createSession(
    async () => ({ username: "alice", identitySeed: "AA==" }),
    closeAccountSession,
  );
}

describe("Session composition", () => {
  it("requires an unlocked account identity", async () => {
    await expect(createSession(async () => undefined, vi.fn()))
      .rejects.toThrow("not unlocked");
    expect(dependencies.createStorage).not.toHaveBeenCalled();
    expect(dependencies.createNetwork).not.toHaveBeenCalled();
  });

  it("constructs stable account-bound components and delegates Network access", async () => {
    const session = await openSession();

    expect(dependencies.createStorage).toHaveBeenCalledWith("alice");
    expect(dependencies.createNetwork).toHaveBeenCalledWith("AA==");
    await expect(session.network()).resolves.toBe(commonNetwork);
    expect(network.access).toHaveBeenCalledOnce();
    expect(session.bootstrapError()).toBeUndefined();

    const storage = session.storage();
    const persistent = session.storage({ persistent: true });
    expect(storage).toBe(session.storage());
    expect(storage).toBe(session.storage({ persistent: false }));
    expect(persistent).toBe(session.storage({ persistent: true }));
    expect(persistent).not.toBe(storage);
    expect(storage.peer("remote")).toBe(storage.peer("remote"));
    expect(persistent.peer("remote")).toBe(persistent.peer("remote"));
    expect(session.signals()).toBe(session.signals());

    await session.close();
  });

  it("isolates Signals between Sessions", async () => {
    const first = await openSession();
    const second = await openSession();
    const owner = {};
    const firstChannel = first.signals().channel<string>(owner, "events");
    const secondChannel = second.signals().channel<string>(owner, "events");
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    firstChannel.subscribe(firstListener);
    secondChannel.subscribe(secondListener);

    firstChannel.publish("first");
    expect(first.signals()).not.toBe(second.signals());
    expect(firstChannel).not.toBe(secondChannel);
    expect(firstListener).toHaveBeenCalledWith("first");
    expect(secondListener).not.toHaveBeenCalled();

    await Promise.all([first.close(), second.close()]);
  });

  it("constructs Options eagerly in the local peer scope", async () => {
    const session = await openSession();
    const service = session.storage({ persistent: true })
      .peer("local")
      .service("options");

    expect(session.options()).toBe(options);
    expect(session.options()).toBe(options);
    expect(dependencies.createOptions).toHaveBeenCalledOnce();
    expect(dependencies.createOptions).toHaveBeenCalledWith(service, session.signals());
    await session.close();
  });

  it("registers Identity after Options with the per-peer predicate", async () => {
    const session = await openSession();
    const services = vi.mocked(network.provide).mock.calls[0]?.[0] as Services;
    const identity = services.identity;
    const remote = { id: "remote" } as Peer;

    expect(dependencies.createOptions.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(network.provide).mock.invocationCallOrder[0]!);
    expect(identity?.enabled?.(remote, commonNetwork)).toBe(true);
    serviceSettings.set("remote/identity", false);
    expect(identity?.enabled?.(remote, commonNetwork)).toBe(false);
    expect((identity?.rpc?.(remote, commonNetwork) as {
      get(): { name: string };
    }).get()).toEqual({ name: "alice" });

    await session.close();
  });

  it("closes initialized dependencies when Options construction fails", async () => {
    const failure = new Error("Options initialization failed.");
    dependencies.createOptions.mockRejectedValueOnce(failure);

    await expect(openSession()).rejects.toBe(failure);

    expect(network.close).toHaveBeenCalledOnce();
    expect(storage.close).toHaveBeenCalledOnce();
    expect(network.provide).not.toHaveBeenCalled();
  });

  it("closes initialized dependencies when Identity registration fails", async () => {
    const failure = new Error("Identity registration failed.");
    vi.mocked(network.provide).mockRejectedValueOnce(failure);

    await expect(openSession()).rejects.toBe(failure);

    expect(dependencies.createOptions).toHaveBeenCalledOnce();
    expect(network.close).toHaveBeenCalledOnce();
    expect(storage.close).toHaveBeenCalledOnce();
  });

  it("closes Storage when Network construction fails", async () => {
    const failure = new Error("Network initialization failed.");
    dependencies.createNetwork.mockRejectedValueOnce(failure);

    await expect(openSession()).rejects.toBe(failure);

    expect(storage.close).toHaveBeenCalledOnce();
    expect(dependencies.createOptions).not.toHaveBeenCalled();
  });
});

describe("Session shutdown", () => {
  it("closes Network, Storage, and Account once", async () => {
    const closeAccountSession = vi.fn(async () => {});
    const session = await openSession(closeAccountSession);

    await Promise.all([session.close(), session.close()]);

    expect(network.close).toHaveBeenCalledOnce();
    expect(storage.close).toHaveBeenCalledOnce();
    expect(closeAccountSession).toHaveBeenCalledOnce();
  });

  it("closes every dependency when one cleanup fails and retains the failure", async () => {
    const failure = new Error("Storage shutdown failed.");
    const closeAccountSession = vi.fn(async () => {});
    const session = await openSession(closeAccountSession);
    vi.mocked(storage.close).mockRejectedValue(failure);

    await expect(session.close()).rejects.toBe(failure);
    await expect(session.close()).rejects.toBe(failure);

    expect(network.close).toHaveBeenCalledOnce();
    expect(storage.close).toHaveBeenCalledOnce();
    expect(closeAccountSession).toHaveBeenCalledOnce();
  });
});
