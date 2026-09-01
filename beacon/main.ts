import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { dirname, extname, resolve, sep } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createBeacon } from "./core.ts";
import { localHosts, tlsOptions } from "../tls.ts";

function configuredPort(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);

  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid port number.`);
  }

  return value;
}

// The two things this server does are independent: it can host the application
// for people whose relay is elsewhere, or provide the relay to applications
// hosted elsewhere. Both are on unless switched off.
const hostsVessel = process.env.VESSEL_HOSTING !== "off";
const providesRelay = process.env.BEACON_RELAY !== "off";
const port = configuredPort("PORT", 4173);
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builtVesselDirectory = resolve(projectDirectory, "dist");
const tls = tlsOptions();

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

async function serveVessel(pathname: string, response: ServerResponse): Promise<void> {
  if (!hostsVessel) {
    response.writeHead(pathname === "/" ? 200 : 404, {
      "content-type": "text/plain; charset=utf-8",
    });
    response.end("brochain relay");
    return;
  }

  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const file = resolve(builtVesselDirectory, `.${requestedPath}`);

  try {
    if (!file.startsWith(`${builtVesselDirectory}${sep}`)) throw new Error("Invalid path.");
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

async function serveApplication(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    await serveVessel(url.pathname, response);
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : "Server error." }));
  }
}

const beacon = providesRelay
  ? await createBeacon({ hosts: localHosts(), port })
  : undefined;

const applicationServer = createHttpsServer(tls, serveApplication);
if (beacon !== undefined) applicationServer.on("upgrade", beacon.handleUpgrade);

applicationServer.listen(port, "0.0.0.0");
try {
  await once(applicationServer, "listening");
} catch (error) {
  await beacon?.close();
  throw error;
}

const provided = [...(hostsVessel ? ["Vessel"] : []), ...(providesRelay ? ["the relay"] : [])];
console.info(`Serving ${provided.join(" and ") || "nothing"} on https://localhost:${port}`);
if (process.env.TLS_CERT_PATH === undefined) {
  console.info("Serving a generated certificate. Set TLS_CERT_PATH and TLS_KEY_PATH to replace it.");
}

async function stopApplication(): Promise<void> {
  const closed = once(applicationServer, "close");
  applicationServer.close();
  await beacon?.close();
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
