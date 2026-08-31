import { createChannel, type Channel } from "../channel.ts";
import type { ByteStream } from "./byte-stream.ts";
import { encodeLine, readLines, splitLine } from "./framing.ts";
import { decodeRpcValue, encodeRpcValue } from "./rpc.ts";

export const eventsProtocol = "/brochain/events/1.0.0";

export interface RemoteEvents<Event> {
  readonly channel: Channel<Event>;
  available(value: boolean): void;
}

export function createRemoteEvents<Event>(
  serviceName: string,
  open: (signal: AbortSignal) => Promise<ByteStream>,
): RemoteEvents<Event> {
  const received = createChannel<Event>();
  let subscriptions = 0;
  let enabled = false;
  let connection: AbortController | undefined;

  function start(): void {
    if (!enabled || subscriptions === 0 || connection !== undefined) return;
    const active = new AbortController();
    connection = active;
    void receive(active).finally(() => {
      if (connection === active) connection = undefined;
    });
  }

  async function receive(active: AbortController): Promise<void> {
    let stream: ByteStream | undefined;
    try {
      stream = await open(active.signal);
      active.signal.throwIfAborted();
      await stream.write(encodeLine({ service: serviceName }), { signal: active.signal });
      for await (const line of readLines(stream)) {
        active.signal.throwIfAborted();
        received.publish(decodeRpcValue(JSON.parse(line)) as Event);
      }
    } catch {
      // Unavailable and closed event feeds remain silent until service state changes.
    } finally {
      if (stream !== undefined && active.signal.aborted) {
        stream.abort(new Error("The event subscription was closed."));
      }
    }
  }

  const channel: Channel<Event> = Object.freeze({
    publish: received.publish,
    subscribe(listener: (event: Event) => unknown) {
      subscriptions += 1;
      const unsubscribe = received.subscribe(listener);
      start();
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        subscriptions -= 1;
        unsubscribe();
        if (subscriptions === 0) {
          connection?.abort();
          connection = undefined;
        }
      };
    },
  });

  return {
    channel,
    available(value) {
      if (enabled === value) return;
      enabled = value;
      connection?.abort();
      connection = undefined;
      start();
    },
  };
}

export async function answerEvents(
  stream: ByteStream,
  service: (name: string) => Channel<unknown> | undefined,
  opened: (serviceName: string, close: () => void) => () => void,
): Promise<void> {
  let unsubscribe = () => {};
  let untrack = () => {};
  try {
    const request = await splitLine(stream);
    const name = serviceName(JSON.parse(request.line));
    const events = service(name);
    if (events === undefined) throw new Error("This event service is not available to the peer.");

    const messages: Uint8Array[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    let failure: Error | undefined;
    const close = (reason = new Error("The event subscription was closed.")) => {
      if (closed) return;
      closed = true;
      failure = reason;
      wake?.();
      stream.abort(reason);
    };
    untrack = opened(name, close);
    unsubscribe = events.subscribe((event) => {
      try {
        messages.push(encodeLine(encodeRpcValue(event)));
        wake?.();
      } catch (reason) {
        close(asError(reason));
      }
    });

    void drain(request.remaining).then(
      () => close(),
      (reason) => close(asError(reason)),
    );
    while (!closed) {
      const message = messages.shift();
      if (message !== undefined) {
        await stream.write(message);
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
    if (failure !== undefined) throw failure;
  } catch (reason) {
    stream.abort(asError(reason));
  } finally {
    unsubscribe();
    untrack();
  }
}

async function drain(source: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const _ of source) {
    // Event subscribers send no data after their request.
  }
}

function serviceName(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("service" in value) ||
    typeof value.service !== "string" ||
    value.service.length === 0
  ) {
    throw new Error("The peer sent an invalid event request.");
  }
  return value.service;
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
