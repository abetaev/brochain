const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeLine(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

export async function splitLine(
  source: AsyncIterable<Uint8Array>,
): Promise<{ readonly line: string; readonly remaining: AsyncIterable<Uint8Array> }> {
  const iterator = source[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let length = 0;

  while (true) {
    const next = await iterator.next();
    if (next.done === true) throw new Error("The peer ended an incomplete frame.");
    requireBytes(next.value);
    const boundary = next.value.indexOf(10);
    if (boundary < 0) {
      chunks.push(next.value);
      length += next.value.byteLength;
      continue;
    }

    chunks.push(next.value.subarray(0, boundary));
    length += boundary;
    return {
      line: decoder.decode(concatenate(chunks, length)),
      remaining: continueSource(next.value.subarray(boundary + 1), iterator),
    };
  }
}

export async function* readLines(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = "";

  for await (const chunk of source) {
    requireBytes(chunk);
    buffered += decoder.decode(chunk, { stream: true });
    let boundary = buffered.indexOf("\n");
    while (boundary >= 0) {
      yield buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 1);
      boundary = buffered.indexOf("\n");
    }
  }

  buffered += decoder.decode();
  if (buffered.length > 0) throw new Error("The peer ended an incomplete frame.");
}

function concatenate(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function* continueSource(
  first: Uint8Array,
  iterator: AsyncIterator<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (first.byteLength > 0) yield first;
  while (true) {
    const next = await iterator.next();
    if (next.done === true) return;
    requireBytes(next.value);
    yield next.value;
  }
}

function requireBytes(value: unknown): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error("A data source may contain only byte arrays.");
  }
}
