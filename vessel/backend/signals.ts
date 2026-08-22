declare const notificationType: unique symbol;

export interface Signal<Notification> {
  readonly [notificationType]: Notification;
}

export interface Signals {
  channel<Notification>(): Signal<Notification>;
  publish<Notification>(signal: Signal<Notification>, notification: Notification): void;
  subscribe<Notification>(
    signal: Signal<Notification>,
    listener: (notification: Notification) => void,
  ): () => void;
}

export function createSignals(): Signals {
  const channels = new Map<Signal<unknown>, Set<(notification: unknown) => void>>();

  function listenersFor<Notification>(
    signal: Signal<Notification>,
  ): Set<(notification: Notification) => void> {
    const listeners = channels.get(signal as Signal<unknown>);
    if (listeners === undefined) {
      throw new Error("Signal does not belong to these Signals.");
    }
    return listeners as unknown as Set<(notification: Notification) => void>;
  }

  return {
    channel<Notification>() {
      const signal = Object.freeze({}) as Signal<Notification>;
      channels.set(signal as Signal<unknown>, new Set());
      return signal;
    },
    publish(signal, notification) {
      for (const listener of [...listenersFor(signal)]) listener(notification);
    },
    subscribe(signal, listener) {
      const listeners = listenersFor(signal);
      listeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
      };
    },
  };
}
