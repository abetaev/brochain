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
import { AppBar } from "@v/frontend/components/AppBar";
import { Avatar } from "@v/frontend/components/Avatar";
import { Button } from "@v/frontend/components/Button";
import { ButtonGroup } from "@v/frontend/components/ButtonGroup";
import { Card } from "@v/frontend/components/Card";
import { EditableLabel } from "@v/frontend/components/EditableLabel";
import { Badge } from "@v/frontend/components/Badge";
import { Toggle } from "@v/frontend/components/Toggle";
import type { Call as CallService, CallState } from "@v/frontend/services/call";
import type { Chat } from "@v/frontend/services/chat";
import type { Roster } from "@v/frontend/services/roster";

export function Peer(props: {
  session: Session;
  roster: Roster;
  chat: Chat;
  call: CallService;
  peerId: string;
  onOpenChat(peerId: string): void;
  onOpenCall(): void;
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
  const [callState, setCallState] = createSignal<CallState | undefined>(props.call.current());
  const [hasUnread, setHasUnread] = createSignal(computeUnread());

  function computeUnread(): boolean {
    const received = props.chat.history(props.peerId)
      .filter((item) => item.direction === "received").length;
    return received > props.chat.readCount(props.peerId);
  }

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
    props.call.updates.subscribe((next) => setCallState(next)),
    props.chat.updates.subscribe((item) => {
      if (item.peerId === props.peerId) setHasUnread(computeUnread());
    }),
    props.chat.reads.subscribe(({ peerId }) => {
      if (peerId === props.peerId) setHasUnread(computeUnread());
    }),
  ];
  onCleanup(() => stops.forEach((stop) => stop()));

  const name = () => entry()?.name ?? props.peerId;
  // A peer which still reports a name can be asked again; one which no longer
  // does leaves only the choice of forgetting what it last reported.
  const reports = () => {
    const peer = entry()?.peer;
    return peer?.isConnected() === true && peer.services().includes(identityServiceName);
  };
  const incomingCall = () => {
    const current = callState();
    return current?.peerId === props.peerId && current.status === "pending" &&
      current.direction === "incoming";
  };
  const connectedPeer = () => {
    const peer = entry()?.peer;
    return peer?.isConnected() === true ? peer : undefined;
  };
  const callable = () => {
    const peer = connectedPeer();
    return peer !== undefined && props.call.available(peer);
  };

  async function attempt(operation: () => Promise<void>): Promise<void> {
    setError(undefined);
    try {
      await operation();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  function startCall(): void {
    const current = connectedPeer();
    if (current === undefined || !callable()) {
      setError("Calls are not available.");
      return;
    }
    void props.call.start(current);
    props.onOpenCall();
  }

  // The observed option drives the control, so a refused write puts it back.
  async function publish(serviceName: string, enabled: boolean): Promise<void> {
    await attempt(async () => {
      try {
        await setServiceEnabled(options, props.peerId, serviceName, enabled);
      } catch (reason) {
        setPublished((current) => new Map(current).set(serviceName, !enabled));
        throw reason;
      }
    });
  }

  return (
    <div class="view">
      <AppBar position="top">
        <Avatar seed={props.peerId} name={name()} />
        <h2 id="peer-heading">Peer {name()}</h2>
        <span class="appbar-end">
          <Avatar
            seed={props.session.username}
            name={props.session.username}
            badges={
              <>
                <Show when={incomingCall()}><Badge variant="call" mode="incoming" /></Show>
                <Show when={hasUnread()}><Badge variant="unread" /></Show>
              </>
            }
            onClick={() => props.onOpenChat(props.peerId)}
            label="Open chat"
          />
        </span>
      </AppBar>
      <main class="view-content">
        <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>

        <section aria-labelledby="services-heading">
          <h3 id="services-heading">Services</h3>
          <p>
            Refused services are withheld from this peer. Refusing the registry leaves
            it no way to learn what is supported, which bars it entirely.
          </p>
          <For each={services}>
            {(serviceName) => (
              <Toggle
                id={`service-${serviceName}`}
                label={serviceName}
                checked={published().get(serviceName) !== false}
                onChange={(checked) => void publish(serviceName, checked)}
              />
            )}
          </For>
          <Toggle id="service-auto-connect" label="Auto Connect" checked={false} disabled hint="Coming soon" />
        </section>

        <Card>
          <dl class="peer-facts">
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
        </Card>

        <figure class="identity-figure">
          <Avatar seed={props.peerId} name={name()} size="lg" />
          <figcaption>
            <EditableLabel
              value={chosen() ?? ""}
              placeholder={name()}
              inputLabel="Name for this peer"
              onSave={(next) => void attempt(async () => await setDisplayName(options, props.peerId, next))}
            />
          </figcaption>
          <Show when={chosen() !== undefined}>
            <button
              class="text-button"
              type="button"
              onClick={() =>
                void attempt(async () => await props.roster.resetDisplayName(props.peerId))}
            >
              Reset name
            </button>
          </Show>
          <Show when={reports() || entry()?.identity !== undefined}>
            <button
              class="text-button"
              type="button"
              onClick={() => void attempt(async () =>
                reports()
                  ? await props.roster.refreshIdentity(props.peerId)
                  : await props.roster.clearIdentity(props.peerId))}
            >
              {reports() ? "Refresh identity" : "Clear identity"}
            </button>
          </Show>
        </figure>
      </main>
      <AppBar position="bottom">
        <Button icon="👈" label="Back" variant="secondary" onClick={props.onBack} />
        <span class="appbar-end">
          <ButtonGroup>
            <Button icon="🤙" label="Call" variant="secondary" disabled={!callable()} onClick={startCall} />
            <Button icon="🗨️" label="Chat" variant="secondary" onClick={() => props.onOpenChat(props.peerId)} />
          </ButtonGroup>
        </span>
      </AppBar>
    </div>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "An unexpected settings error occurred.";
}
