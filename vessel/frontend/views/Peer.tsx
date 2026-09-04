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
import type { Action } from "@v/frontend/components/ActionBar";
import { Avatar } from "@v/frontend/components/Avatar";
import { Card } from "@v/frontend/components/Card";
import { EditableLabel } from "@v/frontend/components/EditableLabel";
import type { Notification } from "@v/frontend/components/StatusBar";
import { Toggle } from "@v/frontend/components/Toggle";
import { Handheld } from "@v/frontend/layouts/Handheld";
import "./Peer.css";
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

  // What is waiting for us while we're looking at this peer, carried by our own
  // avatar the way the mockup places it.
  const notifications = (): Notification[] => [{
    peerId: props.session.username,
    name: props.session.username,
    unread: hasUnread(),
    ...(incomingCall() ? { call: "incoming" as const } : {}),
    onClick: () => props.onOpenChat(props.peerId),
  }];

  const actions = (): Action[] => [
    { side: "start", icon: "👈", label: "Back", onClick: props.onBack },
    {
      side: "end",
      group: "peer",
      icon: "🤙",
      label: "Call",
      disabled: !callable(),
      onClick: startCall,
    },
    {
      side: "end",
      group: "peer",
      icon: "🗨️",
      label: "Chat",
      onClick: () => props.onOpenChat(props.peerId),
    },
  ];

  return (
    <Handheld
      avatar={{ seed: props.peerId, name: name() }}
      title={name()}
      heading={`Peer ${name()}`}
      notifications={notifications()}
      actions={actions()}
    >
      <>
        <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>

        {/* Who this peer is, above what we do with them. */}
        <figure class="peer-identity">
          <Avatar seed={props.peerId} name={name()} size="lg" />
          <figcaption>
            <EditableLabel
              value={chosen() ?? ""}
              placeholder={name()}
              inputLabel="Name for this peer"
              onSave={(next) => void attempt(async () => await setDisplayName(options, props.peerId, next))}
            />
          </figcaption>
          <div class="peer-identity-actions">
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
          </div>
        </figure>

        <Card>
          <dl class="peer-facts">
            <dt>Peer ID</dt>
            <dd class="peer-facts-clipped">{props.peerId}</dd>
            <dt>Reported name</dt>
            <dd>{entry()?.identity?.name ?? "Not yet identified"}</dd>
            <dt>Availability</dt>
            <dd>{entry()?.online === true ? "Connected" : "Not connected"}</dd>
          </dl>
          {/* Addresses are long and rarely read, so they stay folded away. */}
          <details class="peer-addresses">
            <summary>Addresses</summary>
            <Show when={entry()?.addresses.length} fallback={<p>None known</p>}>
              <ul>
                <For each={entry()?.addresses}>
                  {(address) => <li class="peer-facts-clipped">{address}</li>}
                </For>
              </ul>
            </Show>
          </details>
        </Card>

        <section aria-labelledby="services-heading">
          <h3 id="services-heading">Services</h3>
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
        </section>
      </>
    </Handheld>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "An unexpected settings error occurred.";
}
