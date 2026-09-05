import { For, Show, createSignal, onCleanup } from "solid-js";
import {
  isServiceEnabled,
  observeServiceEnabled,
  setServiceEnabled,
} from "@v/backend/options/network-services";
import { identityServiceName } from "@v/backend/network/services/identity";
import type { Session } from "@v/backend/session";
import type { Action } from "@v/frontend/components/ActionBar";
import { Facts } from "@v/frontend/components/Facts";
import { IdentityBlock, createPeerName } from "@v/frontend/components/IdentityBlock";
import type { Notification } from "@v/frontend/services/notifications";
import { Toggle } from "@v/frontend/components/Toggle";
import { Handheld } from "@v/frontend/layouts/Handheld";
import type { Call as CallService } from "@v/frontend/services/call";
import type { Roster } from "@v/frontend/services/roster";

export function Peer(props: {
  session: Session;
  roster: Roster;
  call: CallService;
  peerId: string;
  notifications: readonly Notification[];
  onOpenChat(peerId: string): void;
  onBack(): void;
}) {
  const options = props.session.options();
  const services = props.session.network().services();
  const [entry, setEntry] = createSignal(props.roster.get(props.peerId));
  const [error, setError] = createSignal<string>();
  const [published, setPublished] = createSignal<ReadonlyMap<string, boolean>>(
    new Map(services.map((name) => [name, isServiceEnabled(options, props.peerId, name)])),
  );
  const stops = [
    props.roster.updates.subscribe((update) => {
      if (update.type === "set") {
        if (update.entry.peerId === props.peerId) setEntry(update.entry);
      } else if (update.peerId === props.peerId) {
        setEntry(undefined);
      }
    }),
    ...services.map((name) =>
      observeServiceEnabled(options, props.peerId, name, (enabled) => {
        setPublished((current) => new Map(current).set(name, enabled));
      })
    ),
  ];
  onCleanup(() => stops.forEach((stop) => stop()));

  const name = () => entry()?.name ?? props.peerId;
  const named = createPeerName(options, props.peerId, name);
  // A peer which still reports a name can be asked again; one which no longer
  // does leaves only the choice of forgetting what it last reported.
  const reports = () => {
    const peer = entry()?.peer;
    return peer?.isConnected() === true && peer.services().includes(identityServiceName);
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
    // The call is placed here, but it is the conversation that carries its record
    // and its controls until it is answered.
    void props.call.start(current);
    props.onOpenChat(props.peerId);
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
      notifications={props.notifications}
      actions={actions()}
    >
      <>
        <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>

        {/* Who this peer is, above what we do with them. Resetting a peer's name
            returns it to what the peer last reported, which is more than
            forgetting the name we chose. */}
        <IdentityBlock
          seed={props.peerId}
          name={named}
          onReset={() => props.roster.resetDisplayName(props.peerId)}
          onError={(message) => setError(message)}
          actions={
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
          }
        />

        <Facts
          facts={[
            { term: "Peer ID", value: props.peerId },
            { term: "Reported name", value: entry()?.identity?.name ?? "Not yet identified" },
            { term: "Availability", value: entry()?.online === true ? "Connected" : "Not connected" },
          ]}
          addresses={entry()?.addresses ?? []}
        />

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
