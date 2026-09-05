import { Show, createResource, createSignal } from "solid-js";
import account from "@v/backend/account";
import type { Session } from "@v/backend/session";
import type { Action } from "@v/frontend/components/ActionBar";
import { Facts } from "@v/frontend/components/Facts";
import { IdentityBlock, createPeerName } from "@v/frontend/components/IdentityBlock";
import { Services } from "@v/frontend/components/Services";
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
  const [error, setError] = createSignal<string>();
  // The account username names us until a name of our own is chosen.
  const named = createPeerName(options, peerId, () => props.session.username);
  // Enrolment belongs here because the secrets are unlocked already, so wrapping
  // them for this device asks for no password again.
  const [supported] = createResource(async () => await account.canEnrolAuthenticator());
  const [enrolled, { mutate: showEnrolled, refetch: readEnrolled }] = createResource(
    async () => await account.hasAuthenticator(props.session.username),
  );

  // The switch has already moved by the time the ceremony starts, so a refused one
  // is put back from what the account actually holds, and it decides nothing more
  // until this one is settled.
  const [enrolling, setEnrolling] = createSignal(false);

  async function enrol(wanted: boolean): Promise<void> {
    setError(undefined);
    setEnrolling(true);
    showEnrolled(wanted);

    try {
      await (wanted ? account.enrolAuthenticator() : account.removeAuthenticator());
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "This device could not be set up.",
      );
    }

    await readEnrolled();
    setEnrolling(false);
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

        {/* Signing in again by the verification this device already performs,
            which is what an evicted application returns through. */}
        <section aria-labelledby="unlock-heading">
          <h3 id="unlock-heading">Unlock</h3>
          <Toggle
            id="unlock-authenticator"
            label="This device"
            checked={enrolled() === true}
            // Until the account has answered the switch says nothing, and a device
            // which cannot evaluate the function is offered only the removal of a
            // wrapping it already holds.
            disabled={enrolling() || enrolled() === undefined ||
              (supported() !== true && enrolled() !== true)}
            hint={supported() === false
              ? "This device cannot unlock accounts."
              : "Unlock this account the way this device already verifies you."}
            onChange={(wanted) => void enrol(wanted)}
          />
        </section>
      </>
    </Handheld>
  );
}
