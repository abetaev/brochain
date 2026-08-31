import type { Libp2p } from "libp2p";
import { rpcClient, type JsonRpcResponse, type RpcTransport } from "typed-rpc";
import { handleRpc } from "typed-rpc/server";

export type RPC<Service extends object> = {
  readonly [Method in keyof Service as Service[Method] extends
    (...arguments_: never[]) => unknown ? Method : never]:
    Service[Method] extends (...arguments_: infer Arguments) => infer Result
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
  | readonly ["array", readonly Encoded[]]
  | readonly ["object", readonly (readonly [string, Encoded])[]];

interface Envelope {
  service: string;
  request: unknown;
}

export const rpcProtocol = "/brochain/rpc/1.0.0";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const transcoder = {
  serialize: encodeRpcValue,
  deserialize: decodeRpcValue,
};

export function remoteService<Service extends object>(
  name: string,
  open: (signal: AbortSignal) => Promise<Stream>,
): RPC<Service> {
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
  }) as RPC<Service>;
}

export async function answerRpc(
  stream: Stream,
  service: (name: string) => object | undefined,
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
      implementation,
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

export function encodeRpcValue(value: unknown): Encoded {
  if (value === undefined) return ["undefined"];
  if (value === null) return ["null"];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number" && Number.isFinite(value)) return ["number", value];
  if (typeof value === "string") return ["string", value];
  if (Array.isArray(value)) return ["array", value.map(encodeRpcValue)];
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("RPC values must be JSON-compatible values.");
    }
    return [
      "object",
      Object.entries(value).map(([key, entry]) => [key, encodeRpcValue(entry)]),
    ];
  }

  throw new Error("RPC values must be JSON-compatible values.");
}

export function decodeRpcValue(value: unknown): unknown {
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
    case "array":
      if (Array.isArray(value[1])) return value[1].map(decodeRpcValue);
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
    result[entry[0]] = decodeRpcValue(entry[1]);
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
