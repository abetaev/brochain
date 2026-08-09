import type { Libp2p } from "libp2p";
import { rpcClient, type JsonRpcResponse, type RpcTransport } from "typed-rpc";
import { handleRpc } from "typed-rpc/server";
import { base64ToBytes, bytesToBase64 } from "./base64.ts";

export interface PeerService<Name extends string = string> {
  readonly name: Name;
}

export type RemoteService<Service extends PeerService> = {
  [Method in Exclude<keyof Service, "name">]: Service[Method] extends
    (...arguments_: infer Arguments) => infer Result
    ? (...arguments_: Arguments) => Promise<Awaited<Result>>
    : never;
};

type Stream = Awaited<ReturnType<Libp2p["dialProtocol"]>>;
type Encoded =
  | readonly ["undefined"]
  | readonly ["null"]
  | readonly ["boolean", boolean]
  | readonly ["number", number]
  | readonly ["string", string]
  | readonly ["bytes", string]
  | readonly ["array", readonly Encoded[]]
  | readonly ["object", readonly (readonly [string, Encoded])[]];

interface Envelope {
  service: string;
  request: unknown;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const transcoder = {
  serialize: encode,
  deserialize: decode,
};

export function remoteService<Service extends PeerService>(
  name: Service["name"],
  open: (signal: AbortSignal) => Promise<Stream>,
): RemoteService<Service> {
  const transport: RpcTransport = async (request, signal) => {
    const stream = await open(signal);
    const abort = () => stream.abort(new Error("The RPC call was aborted."));
    signal.addEventListener("abort", abort, { once: true });

    try {
      stream.send(encoder.encode(JSON.stringify({ service: name, request })));
      await stream.close({ signal });
      return await readJson(stream) as JsonRpcResponse;
    } catch (reason) {
      if (stream.status !== "closed" && stream.status !== "aborted") {
        stream.abort(asError(reason));
      }
      throw reason;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
  const client = rpcClient<Service>({ transport, transcoder });

  return new Proxy(client, {
    get(target, property, receiver) {
      if (typeof property === "string" && Object.hasOwn(Object.prototype, property)) {
        return async () => {
          throw new Error(`Invalid RPC method: ${property}`);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as RemoteService<Service>;
}

export async function answerRpc(
  stream: Stream,
  service: (name: string) => PeerService | undefined,
): Promise<void> {
  try {
    const envelope = await readJson(stream);
    if (!isEnvelope(envelope)) throw new Error("Invalid RPC request envelope.");

    const implementation = Object.assign(
      Object.create(null) as Record<string, unknown>,
      service(envelope.service),
    );
    const response = await handleRpc<Record<string, unknown>, unknown>(
      envelope.request,
      implementation as unknown as Record<string, unknown>,
      { transcoder },
    );
    stream.send(encoder.encode(JSON.stringify(response)));
    await stream.close();
  } catch (reason) {
    stream.abort(asError(reason));
  }
}

async function readJson(stream: Stream): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let length = 0;

  for await (const chunk of stream) {
    const bytes = chunk instanceof Uint8Array ? chunk : chunk.subarray();
    chunks.push(bytes);
    length += bytes.byteLength;
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return JSON.parse(decoder.decode(bytes));
}

function encode(value: unknown): Encoded {
  if (value === undefined) return ["undefined"];
  if (value === null) return ["null"];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number" && Number.isFinite(value)) return ["number", value];
  if (typeof value === "string") return ["string", value];
  if (value instanceof Uint8Array) return ["bytes", bytesToBase64(value)];
  if (Array.isArray(value)) return ["array", value.map(encode)];
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("RPC values must be JSON-compatible values or byte arrays.");
    }
    return ["object", Object.entries(value).map(([key, entry]) => [key, encode(entry)])];
  }

  throw new Error("RPC values must be JSON-compatible values or byte arrays.");
}

function decode(value: unknown): unknown {
  if (!Array.isArray(value) || typeof value[0] !== "string") {
    throw new Error("Invalid RPC value.");
  }

  switch (value[0]) {
    case "undefined":
      return undefined;
    case "null":
      return null;
    case "boolean":
      if (typeof value[1] === "boolean") return value[1];
      break;
    case "number":
      if (typeof value[1] === "number" && Number.isFinite(value[1])) return value[1];
      break;
    case "string":
      if (typeof value[1] === "string") return value[1];
      break;
    case "bytes":
      if (typeof value[1] === "string") return base64ToBytes(value[1]);
      break;
    case "array":
      if (Array.isArray(value[1])) return value[1].map(decode);
      break;
    case "object":
      if (Array.isArray(value[1])) return decodeObject(value[1]);
      break;
  }

  throw new Error("Invalid RPC value.");
}

function decodeObject(entries: unknown[]): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);

  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
      throw new Error("Invalid RPC object.");
    }
    result[entry[0]] = decode(entry[1]);
  }

  return result;
}

function isEnvelope(value: unknown): value is Envelope {
  return typeof value === "object" && value !== null &&
    typeof (value as Envelope).service === "string" && "request" in value;
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
