import { describe, expect, it, vi } from "vitest";
import { createSignals } from "./signals.ts";

describe("Signals", () => {
  it("delivers typed notifications synchronously in subscription order without replay", () => {
    const signals = createSignals();
    const signal = signals.channel<{ readonly value: number }>();
    const received: string[] = [];

    signals.publish(signal, { value: 0 });
    signals.subscribe(signal, ({ value }) => received.push(`first:${value}`));
    signals.subscribe(signal, ({ value }) => received.push(`second:${value}`));
    signals.publish(signal, { value: 1 });

    expect(received).toEqual(["first:1", "second:1"]);
  });

  it("isolates channels and stops subscriptions idempotently", () => {
    const signals = createSignals();
    const first = signals.channel<number>();
    const second = signals.channel<number>();
    const listener = vi.fn();
    const unsubscribe = signals.subscribe(first, listener);

    signals.publish(second, 1);
    signals.publish(first, 2);
    unsubscribe();
    unsubscribe();
    signals.publish(first, 3);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(2);
  });

  it("rejects channels owned by another Signals instance", () => {
    const first = createSignals();
    const second = createSignals();
    const signal = first.channel<string>();

    expect(() => second.publish(signal, "notification")).toThrow(
      "Signal does not belong to these Signals.",
    );
    expect(() => second.subscribe(signal, () => {})).toThrow(
      "Signal does not belong to these Signals.",
    );
  });

  it("propagates a subscriber failure and interrupts publication", () => {
    const signals = createSignals();
    const signal = signals.channel<void>();
    const failure = new Error("Subscriber failed.");
    const skipped = vi.fn();

    signals.subscribe(signal, () => {
      throw failure;
    });
    signals.subscribe(signal, skipped);

    expect(() => signals.publish(signal, undefined)).toThrow(failure);
    expect(skipped).not.toHaveBeenCalled();
  });
});
