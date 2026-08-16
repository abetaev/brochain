import { describe, expect, it, vi } from "vitest";
import type { Peer, RemoteService } from "../../../common/network/index.ts";
import { createStorage } from "../../services/storage.ts";
import {
  createIdentity,
  type IdentityService,
} from "./identity.ts";

function peer(id: string): Peer {
  return { id } as Peer;
}

function remote(get: () => Promise<unknown>): RemoteService<IdentityService> {
  return { get } as RemoteService<IdentityService>;
}

describe("Identity", () => {
  it("defines and serves the local Contact", () => {
    const identity = createIdentity("local", createStorage());

    expect(identity.name).toBe("identity");
    expect(identity.serve(peer("remote")).get()).toEqual({ name: "local" });
  });

  it("fetches, validates, and caches each remote Contact in Storage", async () => {
    const getAda = vi.fn(async () => ({ name: "ada" }));
    const getBob = vi.fn(async () => ({ name: "bob" }));
    const storage = createStorage();
    const identity = createIdentity("local", storage);
    const adaPeer = peer("ada-id");
    const bobPeer = peer("bob-id");
    const ada = identity.gateway(adaPeer, remote(getAda));
    const bob = identity.gateway(bobPeer, remote(getBob));

    await expect(ada.get()).resolves.toEqual({ name: "ada" });
    await expect(ada.get()).resolves.toEqual({ name: "ada" });
    await expect(bob.get()).resolves.toEqual({ name: "bob" });

    expect(getAda).toHaveBeenCalledOnce();
    expect(getBob).toHaveBeenCalledOnce();
    expect(storage.peer(adaPeer).value("identity").get()).toEqual({ name: "ada" });
  });

  it("rejects invalid remote identities without caching them", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ name: "Not valid" })
      .mockResolvedValueOnce({ name: "valid" });
    const storage = createStorage();
    const identity = createIdentity("local", storage);
    const remotePeer = peer("peer");
    const gateway = identity.gateway(remotePeer, remote(get));

    await expect(gateway.get()).rejects.toThrow("Peer returned an invalid identity.");
    expect(storage.peer(remotePeer).value("identity").get()).toBeUndefined();
    await expect(gateway.get()).resolves.toEqual({ name: "valid" });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does not share cached Contacts between Sessions", async () => {
    const firstGet = vi.fn(async () => ({ name: "first" }));
    const secondGet = vi.fn(async () => ({ name: "second" }));
    const remotePeer = peer("peer");
    const first = createIdentity("local", createStorage());
    const second = createIdentity("local", createStorage());

    await expect(first.gateway(remotePeer, remote(firstGet)).get()).resolves.toEqual({
      name: "first",
    });
    await expect(second.gateway(remotePeer, remote(secondGet)).get()).resolves.toEqual({
      name: "second",
    });
    expect(secondGet).toHaveBeenCalledOnce();
  });
});
