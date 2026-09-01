import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ServerOptions } from "node:https";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const developmentDirectory = join(dirname(fileURLToPath(import.meta.url)), "dev");

// One list of the addresses this machine answers on. The certificate covers them
// and the Beacon announces them, and a peer only arrives when those agree.
export function localHosts(): readonly string[] {
  const configured = process.env.BEACON_HOST;
  if (configured !== undefined) return [configured];

  const local = Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => address.family === "IPv4" && !address.internal)
    .map((address) => address.address);
  return ["localhost", ...new Set(local)];
}

// Vessel is served over HTTPS in every run mode, because a browser withholds
// `crypto.subtle`, Web Locks and private file storage from anything less. A
// configured certificate is used where there is one; otherwise development
// answers for itself with a certificate kept in `dev` and replaced whenever the
// addresses it covers change. Read where a run mode is configured rather than
// started, so it is read synchronously and once.
export function tlsOptions(hosts: readonly string[] = localHosts()): ServerOptions {
  const certificatePath = process.env.TLS_CERT_PATH;
  const keyPath = process.env.TLS_KEY_PATH;

  if (certificatePath !== undefined && keyPath !== undefined) {
    return { cert: readFileSync(certificatePath), key: readFileSync(keyPath) };
  }
  if (certificatePath !== undefined || keyPath !== undefined) {
    throw new Error("Set both TLS_CERT_PATH and TLS_KEY_PATH, or neither.");
  }

  const generatedCertificate = join(developmentDirectory, "certificate.pem");
  const generatedKey = join(developmentDirectory, "key.pem");
  const namesPath = join(developmentDirectory, "names");
  const names = [...new Set(["localhost", "127.0.0.1", ...hosts])].sort().join("\n");

  try {
    if (readFileSync(namesPath, "utf8") === names) {
      return { cert: readFileSync(generatedCertificate), key: readFileSync(generatedKey) };
    }
  } catch {
    // A missing or unreadable certificate is generated below.
  }

  mkdirSync(developmentDirectory, { recursive: true });
  generateCertificate(generatedCertificate, generatedKey, names.split("\n"));
  writeFileSync(namesPath, names);
  return { cert: readFileSync(generatedCertificate), key: readFileSync(generatedKey) };
}

function generateCertificate(
  certificatePath: string,
  keyPath: string,
  names: readonly string[],
): void {
  const subjectAltName = names
    .map((name) => `${isAddress(name) ? "IP" : "DNS"}:${name}`)
    .join(",");

  try {
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "365",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-subj",
      "/CN=brochain development",
      "-addext",
      `subjectAltName=${subjectAltName}`,
    ], { stdio: "ignore" });
  } catch {
    throw new Error(
      "Unable to generate a development certificate. Install openssl, " +
        "or set TLS_CERT_PATH and TLS_KEY_PATH to a certificate of your own.",
    );
  }
}

function isAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}
