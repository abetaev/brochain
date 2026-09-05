import { Show, createSignal, onCleanup } from "solid-js";
import {
  autoAcceptsConnections,
  observeAutoAcceptConnections,
  setAutoAcceptConnections,
} from "@v/backend/options/local-peer";
import type { Session } from "@v/backend/session";
import type { Action } from "@v/frontend/components/ActionBar";
import { Facts } from "@v/frontend/components/Facts";
import { IdentityBlock, createPeerName } from "@v/frontend/components/IdentityBlock";
import { Toggle } from "@v/frontend/components/Toggle";
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
  const [accepts, setAccepts] = createSignal(autoAcceptsConnections(options, peerId));
  const [error, setError] = createSignal<string>();
  // The account username names us until a name of our own is chosen.
  const named = createPeerName(options, peerId, () => props.session.username);

  onCleanup(observeAutoAcceptConnections(options, peerId, setAccepts));

  async function attempt(operation: () => Promise<void>): Promise<void> {
    setError(undefined);
    try {
      await operation();
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  // The observed option drives the control, so a refused write puts it back.
  async function accept(enabled: boolean): Promise<void> {
    await attempt(async () => {
      try {
        await setAutoAcceptConnections(options, peerId, enabled);
      } catch (reason) {
        setAccepts(!enabled);
        throw reason;
      }
    });
  }

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

        <Toggle
          id="auto-accept-connections"
          label="Accept connections"
          checked={accepts()}
          onChange={(checked) => void accept(checked)}
        />
      </>
    </Handheld>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "An unexpected settings error occurred.";
}
