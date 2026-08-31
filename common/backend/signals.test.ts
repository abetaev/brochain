import { describe, expect, expectTypeOf, it, vi } from "vitest";
import signals from "./signals.ts";

describe("Signals", () => {
  it("returns an independent typed Channel for each request", () => {
        const first = signals.channel<{ readonly value: number }>();
    const second = signals.channel<{ readonly value: number }>();
    const listener = vi.fn();

    second.subscribe(listener);
    first.publish({ value: 1 });

    expect(listener).not.toHaveBeenCalled();
    expectTypeOf(first.publish).parameter(0).toEqualTypeOf<{
      readonly value: number;
    }>();
    expectTypeOf(first.subscribe).parameter(0).returns.toEqualTypeOf<unknown>();
  });

  it("delivers synchronously in subscription order without replay", () => {
    const channel = signals.channel<number>();
    const received: string[] = [];

    channel.publish(0);
    channel.subscribe((value) => received.push(`first:${value}`));
    channel.subscribe((value) => received.push(`second:${value}`));
    channel.publish(1);

    expect(received).toEqual(["first:1", "second:1"]);
  });

  it("keeps duplicate subscriptions independent and stops each idempotently", () => {
    const channel = signals.channel<number>();
    const listener = vi.fn();
    const stopFirst = channel.subscribe(listener);
    const stopSecond = channel.subscribe(listener);

    channel.publish(1);
    stopFirst();
    stopFirst();
    channel.publish(2);
    stopSecond();
    channel.publish(3);

    expect(listener.mock.calls).toEqual([[1], [1], [2]]);
  });

  it("logs and isolates subscriber failures", () => {
    const channel = signals.channel<void>();
    const privatePayload = { message: "private event data" };
    const later = vi.fn();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      channel.subscribe(() => {
        throw privatePayload;
      });
      channel.subscribe(() => {
        later();
        return "ignored";
      });

      expect(() => channel.publish(undefined)).not.toThrow();
      expect(later).toHaveBeenCalledOnce();
      expect(logged.mock.calls).toEqual([["Channel subscriber failed."]]);
    } finally {
      logged.mockRestore();
    }
  });
});
