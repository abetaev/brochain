import { Show, createSignal, onCleanup } from "solid-js";
import { registryServiceName } from "@c/backend/network/services/registry";
import { identityServiceName } from "@v/backend/network/services/identity";
import {
  isAutoConnectEnabled,
  observeAutoConnect,
  setAutoConnect,
} from "@v/backend/options/auto-connect";
import type { Session } from "@v/backend/session";
import type { Action } from "@v/frontend/components/ActionBar";
import { Facts } from "@v/frontend/components/Facts";
import { IdentityBlock, createPeerName } from "@v/frontend/components/IdentityBlock";
import type { Notification } from "@v/frontend/services/notifications";
import { Services } from "@v/frontend/components/Services";
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
  const network = props.session.network();
  const services = network.services();
  const [entry, setEntry] = createSignal(props.roster.get(props.peerId));
  const [error, setError] = createSignal<string>();
  const stop = props.roster.updates.subscribe((update) => {
    if (update.type === "set") {
      if (update.entry.peerId === props.peerId) setEntry(update.entry);
    } else if (update.peerId === props.peerId) {
      setEntry(undefined);
    }
  });
  onCleanup(stop);

  // Anything may mark a peer, this peer's own bar among them, so the switch shows
  // what the Options hold rather than what it was last set to.
  const [marked, setMarked] = createSignal(isAutoConnectEnabled(options, props.peerId));
  onCleanup(
    observeAutoConnect(options, props.peerId, (enabled) => setMarked(enabled === true)),
  );

  // The switch has already moved by the time the write is attempted, so a refused
  // one is put back from what the Options actually hold.
  async function mark(wanted: boolean): Promise<void> {
    setMarked(wanted);
    setError(undefined);
    try {
      await setAutoConnect(options, props.peerId, wanted);
    } catch (reason) {
      setMarked(isAutoConnectEnabled(options, props.peerId));
      setError(errorMessage(reason));
    }
  }

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
  // What a peer actually reaches is what is published to it, so a peer holding
  // nothing but Registry is one nobody has let in yet.
  const availability = () => {
    const peer = connectedPeer();
    if (peer === undefined) return "Not connected";
    const reaches = services.some((name) =>
      name !== registryServiceName && peer.hosts(name)
    );
    return reaches ? "Connected" : "Requesting a connection";
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
            { term: "Availability", value: availability() },
          ]}
          addresses={entry()?.addresses ?? []}
        />

        {/* Reaching a peer is what this application does about it rather than
            something the peer is granted, so it stands apart from the services. */}
        <section aria-labelledby="connection-heading">
          <h3 id="connection-heading">Connection</h3>
          <Toggle
            id="auto-connect"
            label="Connect automatically"
            checked={marked()}
            hint="Reach this peer whenever it becomes available."
            onChange={(wanted) => void mark(wanted)}
          />
        </section>

        {/* Each service says whether it follows the profile or decides for itself. */}
        <Services
          options={options}
          localPeerId={network.id}
          peerId={props.peerId}
          services={services}
          onError={(message) => setError(message)}
        />
      </>
    </Handheld>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "An unexpected settings error occurred.";
}
