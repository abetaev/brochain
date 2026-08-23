export interface StoredData {
  file(name: string, mediaType: string): Promise<File>;
  remove(): Promise<void>;
}

export interface DataWriter {
  readonly data: StoredData;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason: Error): Promise<void>;
}

export interface DataStorage {
  create(size: number): Promise<DataWriter>;
  close(): Promise<void>;
}

const applicationDirectory = "brochain";
const sessionsDirectory = "sessions";
const reservedQuotaRatio = 0.1;

export async function createDataStorage(): Promise<DataStorage> {
  if (
    typeof navigator === "undefined" ||
    navigator.storage?.getDirectory === undefined ||
    navigator.storage.estimate === undefined ||
    navigator.locks === undefined
  ) {
    throw new Error("This browser does not provide private file storage.");
  }

  const root = await navigator.storage.getDirectory();
  const application = await root.getDirectoryHandle(applicationDirectory, { create: true });
  const sessions = await application.getDirectoryHandle(sessionsDirectory, { create: true });
  const sessionId = crypto.randomUUID();
  let releaseLifetime!: () => void;
  const lifetimeReleased = new Promise<void>((resolve) => {
    releaseLifetime = resolve;
  });
  let markAcquired!: () => void;
  const acquired = new Promise<void>((resolve) => {
    markAcquired = resolve;
  });
  const lifetime = navigator.locks.request(lockName(sessionId), async (lock) => {
    if (lock === null) throw new Error("Unable to reserve private file storage.");
    markAcquired();
    await lifetimeReleased;
  });
  await Promise.race([acquired, lifetime]);

  try {
    await removeAbandonedSessions(sessions, sessionId);
    const directory = await sessions.getDirectoryHandle(sessionId, { create: true });
    const writers = new Set<(reason: Error) => Promise<void>>();
    let reserved = 0;
    let closed = false;
    let shutdown: Promise<void> | undefined;

    function requireOpen(): void {
      if (closed) throw new Error("This Session data storage is closed.");
    }

    return {
      async create(size) {
        requireOpen();
        validateSize(size);
        const estimate = await navigator.storage.estimate();
        const quota = estimate.quota ?? 0;
        const usage = estimate.usage ?? 0;
        const usable = Math.floor(quota * (1 - reservedQuotaRatio));
        if (usage + reserved + size > usable) {
          throw new Error("There is not enough private storage for this data transfer.");
        }

        reserved += size;
        const fileName = crypto.randomUUID();
        try {
          const handle = await directory.getFileHandle(fileName, { create: true });
          const writable = await handle.createWritable({ keepExistingData: false });
          let position = 0;
          let finished = false;
          let removed = false;

          const releaseReservation = () => {
            if (finished) return;
            finished = true;
            reserved -= size;
            writers.delete(abort);
          };
          const remove = async () => {
            if (removed) return;
            removed = true;
            await directory.removeEntry(fileName).catch((reason) => {
              if (!isMissingEntry(reason)) throw reason;
            });
          };
          const abort = async (reason: Error) => {
            if (!finished) {
              await writable.abort(reason).catch(() => {});
              releaseReservation();
            }
            await remove();
          };
          writers.add(abort);

          const data: StoredData = {
            async file(name, mediaType) {
              if (removed) throw new Error("This stored data is no longer available.");
              const file = await handle.getFile();
              return new File([file], name, {
                type: mediaType,
                lastModified: file.lastModified,
              });
            },
            remove,
          };

          return {
            data,
            async write(bytes) {
              if (finished) throw new Error("This data writer is closed.");
              if (!(bytes instanceof Uint8Array)) {
                throw new Error("A data writer accepts only byte arrays.");
              }
              if (position + bytes.byteLength > size) {
                throw new Error("The stored data exceeded its declared size.");
              }
              const copy = new Uint8Array(bytes.byteLength);
              copy.set(bytes);
              await writable.write(copy);
              position += bytes.byteLength;
            },
            async close() {
              if (finished) return;
              if (position !== size) {
                await abort(new Error("The stored data did not reach its declared size."));
                throw new Error("The stored data did not reach its declared size.");
              }
              await writable.close();
              releaseReservation();
            },
            abort,
          } satisfies DataWriter;
        } catch (reason) {
          reserved -= size;
          await directory.removeEntry(fileName).catch(() => {});
          throw reason;
        }
      },
      async close() {
        if (shutdown === undefined) {
          closed = true;
          shutdown = (async () => {
            try {
              const reason = new Error("This Session data storage was closed.");
              await Promise.allSettled([...writers].map(async (abort) => await abort(reason)));
              await sessions.removeEntry(sessionId, { recursive: true }).catch((error) => {
                if (!isMissingEntry(error)) throw error;
              });
            } finally {
              releaseLifetime();
              await lifetime;
            }
          })();
        }
        await shutdown;
      },
    };
  } catch (reason) {
    releaseLifetime();
    await lifetime.catch(() => {});
    throw reason;
  }
}

async function removeAbandonedSessions(
  sessions: FileSystemDirectoryHandle,
  current: string,
): Promise<void> {
  for await (const name of sessions.keys()) {
    if (name === current) continue;
    await navigator.locks.request(lockName(name), { ifAvailable: true }, async (lock) => {
      if (lock === null) return;
      await sessions.removeEntry(name, { recursive: true }).catch((reason) => {
        if (!isMissingEntry(reason)) throw reason;
      });
    });
  }
}

function lockName(sessionId: string): string {
  return `brochain-session-data:${sessionId}`;
}

function validateSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Stored data must have a non-negative safe size.");
  }
}

function isMissingEntry(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "NotFoundError";
}
