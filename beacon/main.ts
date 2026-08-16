import { readFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type ServerOptions } from "node:https";
import { dirname, extname, resolve } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createBeacon } from "./index.ts";

function configuredPort(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);

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

  return {
    cert: await readFile(certificatePath),
    key: await readFile(keyPath),
  };
}

const port = configuredPort("PORT", 4173);
const relayPort = configuredPort("BEACON_RELAY_PORT", 9090);
const announcePort = configuredPort("BEACON_PUBLIC_RELAY_PORT", relayPort);
const beaconHost = process.env.BEACON_HOST ?? "localhost";
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builtVesselDirectory = resolve(projectDirectory, "dist");
const tls = await loadTlsOptions();

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

async function serveVessel(pathname: string, response: ServerResponse): Promise<void> {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const file = resolve(builtVesselDirectory, `.${requestedPath}`);

  try {
    if (!file.startsWith(`${builtVesselDirectory}/`)) throw new Error("Invalid path.");
    const contents = await readFile(file);
    response.writeHead(200, {
      "content-type": mimeTypes[extname(file)] ?? "application/octet-stream",
    });
    response.end(contents);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found.");
  }
}

const beacon = await createBeacon({
  host: beaconHost,
  relayPort,
  announcePort,
  tls,
});

async function serveApplication(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    await serveVessel(url.pathname, response);
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Server error." }));
  }
}

const applicationServer = tls === undefined
  ? createHttpServer(serveApplication)
  : createHttpsServer(tls, serveApplication);

applicationServer.listen(port, "0.0.0.0");
try {
  await once(applicationServer, "listening");
} catch (error) {
  await beacon.close();
  throw error;
}

console.info(`Vessel available on ${tls === undefined ? "http" : "https"}://localhost:${port}`);

async function stopApplication(): Promise<void> {
  const closed = once(applicationServer, "close");
  applicationServer.close();
  await beacon.close();
  await closed;
}

async function stopSafely(): Promise<void> {
  try {
    await stopApplication();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
}

process.once("SIGINT", stopSafely);
process.once("SIGTERM", stopSafely);
