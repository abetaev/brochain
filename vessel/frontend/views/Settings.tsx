import { Show, createSignal } from "solid-js";
import type { Session } from "@v/backend/session";
import type { Action } from "@v/frontend/components/ActionBar";
import { Facts } from "@v/frontend/components/Facts";
import { IdentityBlock, createPeerName } from "@v/frontend/components/IdentityBlock";
import { Services } from "@v/frontend/components/Services";
import { Handheld } from "@v/frontend/layouts/Handheld";
import type { Notification } from "@v/frontend/services/notifications";

// This peer's own settings. Options keys us the same way it keys everyone else,
// so this is the Peer view turned on ourselves: the same name, read the same way,
// beside the behaviour that is ours alone to decide.
export function Settings(props: {
  session: Session;
  notifications: readonly Notification[];
  onBack(): void;
}) {
  const options = props.session.options();
  const network = props.session.network();
  const peerId = network.id;
  const [error, setError] = createSignal<string>();
  // The account username names us until a name of our own is chosen.
  const named = createPeerName(options, peerId, () => props.session.username);

  const actions = (): Action[] => [
    { side: "start", icon: "👈", label: "Back", onClick: props.onBack },
  ];

  return (
    <Handheld
      avatar={{ seed: peerId, name: named.shown() }}
      title={named.shown()}
      heading="Settings"
      notifications={props.notifications}
      actions={actions()}
    >
      <>
        <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>

        <IdentityBlock seed={peerId} name={named} onError={(message) => setError(message)} />

        {/* What someone else needs to reach us, which Home's direct connection asks for. */}
        <Facts
          facts={[{ term: "Peer ID", value: peerId }]}
          addresses={network.addresses()}
        />

        {/* Our own list is the profile: what a peer we have decided nothing about
            reaches, and what every peer follows until it is told otherwise. */}
        <Services
          options={options}
          localPeerId={peerId}
          peerId={peerId}
          services={network.services()}
          hint="What a peer you have decided nothing about reaches."
          onError={(message) => setError(message)}
        />
      </>
    </Handheld>
  );
}
