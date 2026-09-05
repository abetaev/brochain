import { For, Show, createSignal, onCleanup } from "solid-js";
import {
  clearServiceEnabled,
  isServiceEnabled,
  observeServiceEnabled,
  overridesService,
  setServiceEnabled,
} from "@v/backend/options/network-services";
import type { Options } from "@v/backend/options";
import { Toggle } from "@v/frontend/components/Toggle";

interface ServiceState {
  readonly enabled: boolean;
  readonly own: boolean;
}

// What one peer may reach. This peer's own list is the connection profile every
// other peer follows while it decides nothing of its own, so both are shown the
// same way and only a remote peer can say where its value came from.
export function Services(props: {
  options: Options;
  localPeerId: string;
  peerId: string;
  services: readonly string[];
  /** What the list governs, where that is not the peer it is shown under. */
  hint?: string;
  /** Called with a failure, and with nothing when a write is attempted afresh. */
  onError: (message?: string) => void;
}) {
  const profile = props.peerId === props.localPeerId;

  function read(): ReadonlyMap<string, ServiceState> {
    return new Map(props.services.map((serviceName) => [serviceName, {
      enabled: isServiceEnabled(props.options, props.localPeerId, props.peerId, serviceName),
      own: overridesService(props.options, props.peerId, serviceName),
    }]));
  }

  const [states, setStates] = createSignal(read());
  const refresh = () => setStates(read());
  // The decision reads this peer and the profile, so a change to either is one.
  const stops = props.services.flatMap((serviceName) => [
    observeServiceEnabled(props.options, props.peerId, serviceName, refresh),
    ...(profile
      ? []
      : [observeServiceEnabled(props.options, props.localPeerId, serviceName, refresh)]),
  ]);
  onCleanup(() => stops.forEach((stop) => stop()));

  // The switch has already moved by the time a write is attempted, so a refused
  // one is put back from what the Options actually hold.
  async function attempt(serviceName: string, operation: () => Promise<void>): Promise<void> {
    props.onError();
    try {
      await operation();
    } catch (reason) {
      refresh();
      props.onError(
        reason instanceof Error ? reason.message : `The ${serviceName} service could not be set.`,
      );
    }
  }

  function publish(serviceName: string, enabled: boolean): void {
    setStates((current) => new Map(current).set(serviceName, { enabled, own: true }));
    void attempt(serviceName, async () =>
      await setServiceEnabled(props.options, props.peerId, serviceName, enabled));
  }

  function follow(serviceName: string): void {
    void attempt(serviceName, async () =>
      await clearServiceEnabled(props.options, props.peerId, serviceName));
  }

  return (
    <section aria-labelledby="services-heading">
      <h3 id="services-heading">Services</h3>
      <Show when={props.hint}>{(hint) => <p>{hint()}</p>}</Show>
      <For each={props.services}>
        {(serviceName) => (
          <Toggle
            id={`service-${serviceName}`}
            label={serviceName}
            checked={states().get(serviceName)?.enabled === true}
            onChange={(checked) => publish(serviceName, checked)}
            actions={
              <Show when={!profile}>
                <Show
                  when={states().get(serviceName)?.own}
                  fallback={<small>Default</small>}
                >
                  <button
                    class="text-button"
                    type="button"
                    onClick={() => follow(serviceName)}
                  >
                    Use default
                  </button>
                </Show>
              </Show>
            }
          />
        )}
      </For>
    </section>
  );
}
