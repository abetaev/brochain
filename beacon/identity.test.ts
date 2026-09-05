import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bytesToBase64 } from "../common/base64.ts";
import { beaconIdentity } from "./identity.ts";

const temporaryDirectories: string[] = [];

async function identityPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "brochain-beacon-"));
  temporaryDirectories.push(directory);
  return join(directory, ".beacon-identity");
}

async function peerId(path: string): Promise<string> {
  return peerIdFromPrivateKey(await beaconIdentity(path)).toString();
}

afterEach(async () => {
  delete process.env.BEACON_IDENTITY;
  await Promise.all(temporaryDirectories.splice(0)
    .map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("Beacon identity", () => {
  it("generates one identity and keeps it for every later start", async () => {
    const path = await identityPath();

    const generated = await peerId(path);
    const retained = await readFile(path, "utf8");

    expect(await peerId(path)).toBe(generated);
    expect(await readFile(path, "utf8")).toBe(retained);
  });

  it("takes the identity a deployment supplied", async () => {
    const path = await identityPath();
    const seed = crypto.getRandomValues(new Uint8Array(32));
    await writeFile(path, `${bytesToBase64(seed)}\n`);

    const supplied = await peerId(path);
    await writeFile(path, `${bytesToBase64(crypto.getRandomValues(new Uint8Array(32)))}\n`);

    expect(await peerId(path)).not.toBe(supplied);
  });

  it("refuses an identity it cannot read rather than replacing it", async () => {
    const path = await identityPath();
    await writeFile(path, "not an identity\n");

    await expect(peerId(path)).rejects.toThrow(path);
    expect(await readFile(path, "utf8")).toBe("not an identity\n");
  });

  it("is named by BEACON_IDENTITY", async () => {
    const path = await identityPath();
    process.env.BEACON_IDENTITY = path;

    const generated = peerIdFromPrivateKey(await beaconIdentity()).toString();

    expect(await peerId(path)).toBe(generated);
  });
});
