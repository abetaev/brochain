import { For, Show, createSignal, onCleanup } from "solid-js";
import {
  isServiceEnabled,
  observeServiceEnabled,
  setServiceEnabled,
} from "@v/backend/options/network-services";
import {
  displayName,
  observeDisplayName,
  setDisplayName,
} from "@v/backend/options/peer-names";
import { identityServiceName } from "@v/backend/network/services/identity";
import type { Session } from "@v/backend/session";
import type { Roster } from "@v/frontend/services/roster";

export function Peer(props: {
  session: Session;
  roster: Roster;
  peerId: string;
  onBack(): void;
}) {
  const options = props.session.options();
  const services = props.session.network().services();
  const [entry, setEntry] = createSignal(props.roster.get(props.peerId));
  const [error, setError] = createSignal<string>();
  const [published, setPublished] = createSignal<ReadonlyMap<string, boolean>>(
    new Map(services.map((name) => [name, isServiceEnabled(options, props.peerId, name)])),
  );
  const [chosen, setChosen] = createSignal(displayName(options, props.peerId));

  const stops = [
    props.roster.updates.subscribe((update) => {
      if (update.type === "set") {
        if (update.entry.peerId === props.peerId) setEntry(update.entry);
      } else if (update.peerId === props.peerId) {
        setEntry(undefined);
      }
    }),
    observeDisplayName(options, props.peerId, setChosen),
    ...services.map((name) =>
      observeServiceEnabled(options, props.peerId, name, (enabled) => {
        setPublished((current) => new Map(current).set(name, enabled));
      })
    ),
  ];
  onCleanup(() => stops.forEach((stop) => stop()));

  const name = () => entry()?.name ?? props.peerId;
  // A peer which still reports a name can be asked again; one which no longer
  // does leaves only the choice of forgetting what it last reported.
  const reports = () => {
    const peer = entry()?.peer;
    return peer?.isConnected() === true && peer.services().includes(identityServiceName);
  };

  async function attempt(operation: () => Promise<void>): Promise<void> {
    setError(undefined);
    try {
      await operation();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  // The observed option drives the control, so a refused write puts it back.
  async function publish(
    serviceName: string,
    enabled: boolean,
    control: HTMLInputElement,
  ): Promise<void> {
    await attempt(async () => {
      try {
        await setServiceEnabled(options, props.peerId, serviceName, enabled);
      } catch (reason) {
        control.checked = !enabled;
        throw reason;
      }
    });
  }

  async function saveName(
    event: SubmitEvent & { currentTarget: HTMLFormElement },
  ): Promise<void> {
    event.preventDefault();
    const entered = String(new FormData(event.currentTarget).get("display-name") ?? "");
    await attempt(async () => await setDisplayName(options, props.peerId, entered));
  }

  return (
    <section aria-labelledby="peer-heading">
      <header>
        <button class="secondary" type="button" onClick={props.onBack}>Back</button>
        <h2 id="peer-heading">Peer {name()}</h2>
      </header>
      <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>

      <dl>
        <dt>Peer ID</dt>
        <dd>{props.peerId}</dd>
        <dt>Reported name</dt>
        <dd>{entry()?.identity?.name ?? "Not yet identified"}</dd>
        <dt>Availability</dt>
        <dd>{entry()?.online === true ? "Connected" : "Not connected"}</dd>
        <dt>Addresses</dt>
        <dd>
          <Show when={entry()?.addresses.length} fallback="None known">
            <ul>
              <For each={entry()?.addresses}>{(address) => <li>{address}</li>}</For>
            </ul>
          </Show>
        </dd>
      </dl>

      <section aria-labelledby="name-heading">
        <h3 id="name-heading">Name</h3>
        <form onSubmit={saveName}>
          <label for="display-name">
            Name for this peer
            <input
              id="display-name"
              name="display-name"
              maxlength="64"
              required
              value={chosen() ?? ""}
            />
          </label>
          <button type="submit">Save name</button>
        </form>
        <Show when={chosen() !== undefined}>
          <button
            class="secondary"
            type="button"
            onClick={() =>
              void attempt(async () => await props.roster.resetDisplayName(props.peerId))}
          >
            Reset name
          </button>{" "}
        </Show>
        <Show when={reports() || entry()?.identity !== undefined}>
          <button
            class="secondary"
            type="button"
            onClick={() => void attempt(async () =>
              reports()
                ? await props.roster.refreshIdentity(props.peerId)
                : await props.roster.clearIdentity(props.peerId))}
          >
            {reports() ? "Refresh identity" : "Clear identity"}
          </button>
        </Show>
      </section>

      <section aria-labelledby="services-heading">
        <h3 id="services-heading">Services</h3>
        <p>
          Refused services are withheld from this peer. Refusing the registry leaves
          it no way to learn what is supported, which bars it entirely.
        </p>
        <fieldset>
          <For each={services}>
            {(serviceName) => (
              <label>
                <input
                  type="checkbox"
                  role="switch"
                  checked={published().get(serviceName) !== false}
                  onChange={(event) =>
                    void publish(serviceName, event.currentTarget.checked, event.currentTarget)}
                />
                {serviceName}
              </label>
            )}
          </For>
        </fieldset>
      </section>
    </section>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "An unexpected settings error occurred.";
}
