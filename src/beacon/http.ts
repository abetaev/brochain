import type { IncomingMessage, ServerResponse } from "node:http";
import type { BeaconRuntime } from "./runtime.ts";
import type { PeerRegistration } from "./registry.ts";

const MAX_REQUEST_BYTES = 16_384;

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = "";

  for await (const chunk of request) {
    body += chunk.toString();

    if (body.length > MAX_REQUEST_BYTES) {
      throw new Error("Request body is too large.");
    }
  }

  return JSON.parse(body);
}

function isPeerRegistration(value: unknown): value is PeerRegistration {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PeerRegistration).peerId === "string" &&
    typeof (value as PeerRegistration).name === "string" &&
    Array.isArray((value as PeerRegistration).addresses) &&
    (value as PeerRegistration).addresses.every((address) => typeof address === "string")
  );
}

export async function handleBeaconRequest(
  runtime: BeaconRuntime,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (url.pathname === "/api/beacon" && request.method === "GET") {
    sendJson(response, 200, { relayMultiaddr: runtime.relayMultiaddr });
    return true;
  }

  if (url.pathname !== "/api/peers") {
    return false;
  }

  if (request.method === "GET") {
    sendJson(response, 200, { peers: runtime.peers.list(url.searchParams.get("exclude") ?? undefined) });
    return true;
  }

  if (request.method === "POST") {
    try {
      const registration = await readJson(request);

      if (!isPeerRegistration(registration)) {
        sendJson(response, 400, { error: "Invalid peer registration." });
        return true;
      }

      sendJson(response, 201, { peer: runtime.peers.register(registration) });
      return true;
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid request." });
      return true;
    }
  }

  sendJson(response, 405, { error: "Method not allowed." });
  return true;
}
