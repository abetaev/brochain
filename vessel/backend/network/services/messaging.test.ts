import { describe, expect, it, vi } from "vitest";
import { createStorage, type ServiceStorage } from "@v/backend/storage";
import {
  createMessaging,
  messageDeliveryError,
  type MessagingEvent,
  transferFile,
  validateMessageText,
} from "./messaging.ts";

function messagingStorage(): ServiceStorage {
  return createStorage().peer("remote-peer").service("messaging");
}

describe("Messaging", () => {
  it("retains validated inbound text and files in its designated service storage", async () => {
    const storage = messagingStorage();
    const messaging = createMessaging(storage);

    expect(messaging).toEqual({
      sendText: expect.any(Function),
      sendFile: expect.any(Function),
    });
    expect("name" in messaging).toBe(false);
    messaging.sendText("  exact text  ");
    messaging.sendFile({
      name: "note.txt",
      mediaType: "text/plain",
      data: new TextEncoder().encode("contents"),
    });

    const events = storage.event<MessagingEvent>().read();
    expect(events.map(({ type }) => type)).toEqual(["received", "received"]);
    expect(events[0]).toEqual({
      type: "received",
      content: { type: "text", text: "  exact text  " },
    });
    const fileEvent = events[1];
    expect(fileEvent?.type).toBe("received");
    if (fileEvent?.type === "received" && fileEvent.content.type === "file") {
      expect(fileEvent.content.file.name).toBe("note.txt");
      expect(fileEvent.content.file.type).toBe("text/plain");
      await expect(fileEvent.content.file.text()).resolves.toBe("contents");
    }
  });

  it("rejects invalid inbound values without recording them", () => {
    const storage = messagingStorage();
    const messaging = createMessaging(storage);

    expect(() => messaging.sendText(" \n ")).toThrow("Enter a message.");
    expect(() => messaging.sendFile({
      name: "note.txt",
      mediaType: "text/plain",
      data: [],
    } as unknown as Parameters<typeof messaging.sendFile>[0])).toThrow(
      "Peer sent an invalid file.",
    );
    expect(storage.event().read()).toEqual([]);
  });

  it("isolates service instances backed by independent Session storage", () => {
    const firstStorage = messagingStorage();
    const secondStorage = messagingStorage();

    createMessaging(firstStorage).sendText("first only");

    expect(firstStorage.event().read()).toHaveLength(1);
    expect(secondStorage.event().read()).toEqual([]);
  });

  it("provides pure outgoing validation and browser file conversion helpers", async () => {
    expect(validateMessageText("  preserved  ")).toBe("  preserved  ");
    expect(() => validateMessageText("\t")).toThrow("Enter a message.");

    const transferred = await transferFile(new File(
      ["contents"],
      "note.txt",
      { type: "text/plain" },
    ));
    expect({ ...transferred, data: [...transferred.data] }).toEqual({
      name: "note.txt",
      mediaType: "text/plain",
      data: [...new TextEncoder().encode("contents")],
    });
  });

  it("normalizes delivery failure messages for explicit callers", () => {
    expect(messageDeliveryError(new Error("Peer disconnected."))).toBe(
      "Peer disconnected.",
    );
    expect(messageDeliveryError("Unavailable.")).toBe("Unavailable.");
    expect(messageDeliveryError(undefined)).toBe("Message delivery failed.");
  });

  it("notifies UI subscribers only after an incoming event is retained", () => {
    const storage = messagingStorage();
    const events = storage.event<MessagingEvent>();
    const listener = vi.fn((event: MessagingEvent) => {
      expect(events.read().at(-1)).toBe(event);
    });
    events.subscribe(listener);

    createMessaging(storage).sendText("hello");

    expect(listener).toHaveBeenCalledOnce();
  });
});
