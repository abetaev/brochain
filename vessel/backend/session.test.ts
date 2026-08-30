// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

let network: Network;
let options: Options;
let storage: Storage;
let optionStorage: object;

beforeEach(() => {
  network = {
    id: "local",
    close: vi.fn(async () => {}),
  } as unknown as Network;
  options = {} as Options;
  optionStorage = {};
  const volatilePeer = { service: vi.fn(() => ({})) };
  const persistentPeer = { service: vi.fn(() => ({})) };
  storage = {
    persistent: {
      service: vi.fn(() => optionStorage),
      peer: vi.fn(() => persistentPeer),
    },
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

  it("constructs Storage, Options, then Network and exposes stable components", async () => {
    const session = await openSession();

    expect(dependencies.createStorage).toHaveBeenCalledWith("alice");
    expect(dependencies.createOptions.mock.invocationCallOrder[0])
      .toBeLessThan(dependencies.createNetwork.mock.invocationCallOrder[0]!);
    expect(dependencies.createNetwork).toHaveBeenCalledWith(
      "AA==",
      "alice",
      options,
      session.signals(),
    );
    expect(session.network()).toBe(network);
    expect(session.network()).toBe(network);
    expect(session.options()).toBe(options);
    expect(session.options()).toBe(options);

    const volatile = session.storage();
    const persistent = session.storage({ persistent: true });
    expect(volatile).toBe(session.storage({ persistent: false }));
    expect(persistent).toBe(session.storage({ persistent: true }));
    expect(volatile.peer("remote")).toBe(volatile.peer("remote"));
    expect(persistent.peer("remote")).toBe(persistent.peer("remote"));
  });

  it("constructs Options in account-level persistent service storage", async () => {
    const session = await openSession();

    expect(storage.persistent.service).toHaveBeenCalledWith("options");
    expect(dependencies.createOptions).toHaveBeenCalledWith(
      optionStorage,
      session.signals(),
    );
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
  });

  it("closes Storage when Options construction fails", async () => {
    const failure = new Error("Options initialization failed.");
    dependencies.createOptions.mockRejectedValueOnce(failure);

    await expect(openSession()).rejects.toBe(failure);

    expect(storage.close).toHaveBeenCalledOnce();
    expect(dependencies.createNetwork).not.toHaveBeenCalled();
  });

  it("closes Storage when Network construction fails", async () => {
    const failure = new Error("Network initialization failed.");
    dependencies.createNetwork.mockRejectedValueOnce(failure);

    await expect(openSession()).rejects.toBe(failure);

    expect(dependencies.createOptions).toHaveBeenCalledOnce();
    expect(storage.close).toHaveBeenCalledOnce();
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
