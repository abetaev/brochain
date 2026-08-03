import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer, type ServerOptions } from "node:https";
import { extname, resolve } from "node:path";
import { handleBeaconRequest } from "./src/beacon/http.ts";
import { createBeacon } from "./src/beacon/runtime.ts";

function environmentPort(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);

  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid port number.`);
  }

  return value;
}

async function loadTlsOptions(): Promise<ServerOptions | undefined> {
  const certificatePath = process.env.TLS_CERT_PATH;
  const keyPath = process.env.TLS_KEY_PATH;

  if (certificatePath === undefined && keyPath === undefined) {
    return undefined;
  }

  if (certificatePath === undefined || keyPath === undefined) {
    throw new Error("Set both TLS_CERT_PATH and TLS_KEY_PATH to enable HTTPS and WSS.");
  }

  const { readFile } = await import("node:fs/promises");
  return { cert: await readFile(certificatePath), key: await readFile(keyPath) };
}

const port = environmentPort("PORT", 4173);
const relayPort = environmentPort("BEACON_RELAY_PORT", 9090);
const announcePort = environmentPort("BEACON_PUBLIC_RELAY_PORT", relayPort);
const beaconHost = process.env.BEACON_HOST ?? "localhost";
const distDirectory = resolve("dist");
const tls = await loadTlsOptions();

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function serveVessel(pathname: string, response: import("node:http").ServerResponse) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const candidate = resolve(distDirectory, `.${requestedPath}`);
  const file = candidate.startsWith(distDirectory) ? candidate : resolve(distDirectory, "index.html");

  try {
    const fileStat = await stat(file);

    if (!fileStat.isFile()) {
      throw new Error("Not a file");
    }

    response.writeHead(200, { "content-type": mimeTypes[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  } catch {
    const fallback = resolve(distDirectory, "index.html");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    createReadStream(fallback).pipe(response);
  }
}

const beacon = await createBeacon({
  host: beaconHost,
  relayPort,
  announcePort,
  tls,
});
const requestHandler = (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => {
  void (async () => {
    if (await handleBeaconRequest(beacon, request, response)) {
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    await serveVessel(url.pathname, response);
  })().catch((error: unknown) => {
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Server error." }));
  });
};
const server = tls === undefined ? createHttpServer(requestHandler) : createHttpsServer(tls, requestHandler);

server.listen(port, "0.0.0.0", () => {
  console.info(`Vessel available on ${tls === undefined ? "http" : "https"}://localhost:${port}`);
  console.info(`Beacon relay available at ${beacon.relayMultiaddr}`);
});

async function stop() {
  await beacon.stop();
  server.close();
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
