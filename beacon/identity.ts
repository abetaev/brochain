import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { base64ToBytes, bytesToBase64 } from "../common/base64.ts";

const seedLength = 32;
// One deployment has one relay, so the file belongs to the deployment rather than to
// whichever run mode started it, and is found from here rather than from a working
// directory.
const retainedIdentityPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".beacon-identity",
);

function errorCode(reason: unknown): string | undefined {
  return typeof reason === "object" && reason !== null && "code" in reason
    ? String((reason as { code: unknown }).code)
    : undefined;
}

function decodeSeed(contents: string, path: string): Uint8Array {
  try {
    const seed = base64ToBytes(contents.trim());
    if (seed.byteLength === seedLength) return seed;
  } catch {
    // What a reader can act on is that this file is not an identity, which is below.
  }

  throw new Error(`The Beacon identity at ${path} is not a ${seedLength}-byte seed.`);
}

// An identity which exists and cannot be read is refused rather than replaced: a new one
// orphans every roster entry, name, and decision a peer holds about the relay.
async function retainedSeed(path: string): Promise<Uint8Array | undefined> {
  try {
    return decodeSeed(await readFile(path, "utf8"), path);
  } catch (reason) {
    if (errorCode(reason) === "ENOENT") return undefined;
    throw reason;
  }
}

async function generateSeed(path: string): Promise<Uint8Array> {
  const seed = crypto.getRandomValues(new Uint8Array(seedLength));

  try {
    await writeFile(path, `${bytesToBase64(seed)}\n`, { flag: "wx", mode: 0o600 });
  } catch (reason) {
    if (errorCode(reason) !== "EEXIST") throw reason;
    // A relay which started at the same moment retained its own, which is the one this
    // deployment now has.
    return decodeSeed(await readFile(path, "utf8"), path);
  }

  return seed;
}

// Beacon keeps one identity across restarts, so a peer which met the relay still knows it.
// The seed is generated once and read thereafter; a deployment supplies or replaces one
// through BEACON_IDENTITY, which names the file.
export async function beaconIdentity(path = process.env.BEACON_IDENTITY ?? retainedIdentityPath) {
  const seed = await retainedSeed(path) ?? await generateSeed(path);
  return await generateKeyPairFromSeed("Ed25519", seed);
}
