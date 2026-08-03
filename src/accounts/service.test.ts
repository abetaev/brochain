import { describe, expect, it } from "vitest";
import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { base64ToBytes } from "./crypto";
import { createIndexedDbAccountRepository } from "./repository";
import { AccountService } from "./service";

describe("AccountService", () => {
  it("stores encrypted account data and unlocks it with the correct password", async () => {
    const repository = createIndexedDbAccountRepository(`accounts-${crypto.randomUUID()}`);
    const service = new AccountService(
      repository,
      () => "account-1",
      () => new Date("2026-08-02T00:00:00.000Z"),
    );
    const password = "correct horse battery staple";

    const created = await service.create("  Ada  ", password);
    const stored = await repository.get(created.id);

    expect(stored).toMatchObject({
      id: "account-1",
      name: "Ada",
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    expect(JSON.stringify(stored)).not.toContain(password);
    const unlocked = await service.unlock(created.id, password);

    expect(unlocked).toMatchObject({
      id: "account-1",
      name: "Ada",
      secrets: { version: 1 },
    });
    const restoredPrivateKey = await generateKeyPairFromSeed(
      "Ed25519",
      base64ToBytes(unlocked.secrets.identitySeed),
    );
    expect(peerIdFromPrivateKey(restoredPrivateKey).toString()).toBe(
      unlocked.secrets.peerId,
    );
    await expect(service.unlock(created.id, "wrong password")).rejects.toThrow(
      "The password is incorrect.",
    );
  });

  it("exports and deletes the encrypted account record", async () => {
    const repository = createIndexedDbAccountRepository(`accounts-${crypto.randomUUID()}`);
    const service = new AccountService(repository, () => "account-2");
    const created = await service.create("Bea", "another secure password");

    const exported = await service.export(created.id);
    await service.remove(created.id);

    expect(exported).toContain('"id": "account-2"');
    await expect(repository.get(created.id)).resolves.toBeUndefined();
  });
});
