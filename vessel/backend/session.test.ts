// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Network as CommonNetwork } from "@c/backend/network";
import type { Network } from "@v/backend/network";
import type { Options } from "./options";

const dependencies = vi.hoisted(() => ({
  createNetwork: vi.fn(),
  createOptions: vi.fn(),
}));

vi.mock("@v/backend/network", () => ({ createNetwork: dependencies.createNetwork }));
vi.mock("@v/backend/options", () => ({ createOptions: dependencies.createOptions }));

import { createSession } from "./session.ts";

let commonNetwork: CommonNetwork;
let network: Network;
let options: Options;

beforeEach(() => {
  commonNetwork = { id: "local" } as CommonNetwork;
  network = {
    id: vi.fn(async () => commonNetwork.id),
    access: vi.fn(async () => commonNetwork),
    bootstrapError: vi.fn(),
    close: vi.fn(async () => {}),
  };
  options = { cat: vi.fn() } as unknown as Options;
  dependencies.createNetwork.mockReset().mockReturnValue(network);
  dependencies.createOptions.mockReset().mockResolvedValue(options);
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
    expect(dependencies.createNetwork).not.toHaveBeenCalled();
  });

  it("constructs stable account-bound components and delegates Network access", async () => {
    const session = await openSession();

    expect(dependencies.createNetwork).toHaveBeenCalledWith("alice", "AA==");
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

  it("memoizes Options in the local peer scope without accessing the Beacon", async () => {
    const session = await openSession();
    const service = session.storage({ persistent: true })
      .peer("local")
      .service("options");

    const [first, second] = await Promise.all([session.options(), session.options()]);

    expect(first).toBe(options);
    expect(second).toBe(options);
    expect(network.id).toHaveBeenCalledOnce();
    expect(network.access).not.toHaveBeenCalled();
    expect(dependencies.createOptions).toHaveBeenCalledOnce();
    expect(dependencies.createOptions).toHaveBeenCalledWith(service, session.signals());
    await session.close();
  });

  it("reports Options initialization failure and retries it", async () => {
    const failure = new Error("Options initialization failed.");
    dependencies.createOptions
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(options);
    const session = await openSession();

    await expect(session.options()).rejects.toBe(failure);
    await expect(session.options()).resolves.toBe(options);

    expect(dependencies.createOptions).toHaveBeenCalledTimes(2);
    expect(network.id).toHaveBeenCalledTimes(2);
    await session.close();
  });
});

describe("Session shutdown", () => {
  it("closes Network, Storage, and Account once", async () => {
    const closeAccountSession = vi.fn(async () => {});
    const session = await openSession(closeAccountSession);
    const closeStorage = vi.spyOn(session.storage(), "close");

    await Promise.all([session.close(), session.close()]);

    expect(network.close).toHaveBeenCalledOnce();
    expect(closeStorage).toHaveBeenCalledOnce();
    expect(closeAccountSession).toHaveBeenCalledOnce();
  });

  it("closes every dependency when one cleanup fails and retains the failure", async () => {
    const failure = new Error("Storage shutdown failed.");
    const closeAccountSession = vi.fn(async () => {});
    const session = await openSession(closeAccountSession);
    const closeStorage = vi.spyOn(session.storage(), "close").mockRejectedValue(failure);

    await expect(session.close()).rejects.toBe(failure);
    await expect(session.close()).rejects.toBe(failure);

    expect(network.close).toHaveBeenCalledOnce();
    expect(closeStorage).toHaveBeenCalledOnce();
    expect(closeAccountSession).toHaveBeenCalledOnce();
  });
});
