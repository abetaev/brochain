import { describe, expect, it, vi } from "vitest";
import { createMessaging, type ReceivedMessage } from "./messaging.ts";

describe("Messaging", () => {
  it("publishes exact validated inbound text without retaining it", () => {
    const messaging = createMessaging();
    const received: ReceivedMessage[] = [];
    messaging.events.subscribe((event) => received.push(event));

    messaging.remote.send("  exact text  ");

    expect(received).toEqual([{ message: "  exact text  " }]);
    expect(() => messaging.remote.send(" \n ")).toThrow("invalid text");
    expect(() => messaging.remote.send(undefined as unknown as string))
      .toThrow("invalid text");
    expect(received).toHaveLength(1);
  });

  it("isolates subscriber failures from inbound RPC and other consumers", () => {
    const messaging = createMessaging();
    const later = vi.fn();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      messaging.events.subscribe(() => {
        throw new Error("Chat subscriber failed.");
      });
      messaging.events.subscribe(later);

      expect(() => messaging.remote.send("hello")).not.toThrow();
      expect(later).toHaveBeenCalledWith({ message: "hello" });
      expect(logged.mock.calls).toEqual([["Channel subscriber failed."]]);
    } finally {
      logged.mockRestore();
    }
  });

  it("keeps each peer-bound instance and its events separate", () => {
        const first = createMessaging();
    const second = createMessaging();
    const firstEvents = vi.fn();
    const secondEvents = vi.fn();
    first.events.subscribe(firstEvents);
    second.events.subscribe(secondEvents);

    first.remote.send("first");

    expect(first).not.toBe(second);
    expect(firstEvents).toHaveBeenCalledOnce();
    expect(secondEvents).not.toHaveBeenCalled();
  });
});
