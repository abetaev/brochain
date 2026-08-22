import { For, Show, createMemo, createResource, createSignal, onCleanup } from "solid-js";
import type { Peer } from "@c/backend/network";
import {
  registryServiceName,
  validateServiceNames,
  type Registry,
} from "@c/backend/network/services/registry";
import {
  identityServiceName,
  loadContact,
  type IdentityService,
} from "@v/backend/network/services/identity";
import {
  messagingServiceName,
  type MessagingEvent,
} from "@v/backend/network/services/messaging";
import type { Session } from "@v/backend/session";
import type { Roster } from "@v/frontend/services/roster";

interface ListedPeer {
  readonly peer: Peer;
  readonly name: string;
  readonly connected: boolean;
  readonly messaging: boolean;
}

export function Home(props: {
  session: Session;
  roster: Roster;
  onOpenChat(peerId: string): void;
  onSignedOut(): void;
}) {
  const [actionError, setActionError] = createSignal<string>();
  const [actionBusy, setActionBusy] = createSignal(false);
  let active = true;
  let stopRoster: (() => void) | undefined;

  async function describe(peer: Peer): Promise<ListedPeer> {
    const connected = peer.isConnected();
    let name = peer.id;
    let messaging = false;

    if (connected) {
      try {
        const services = validateServiceNames(
          await peer.service<Registry>(registryServiceName).list(),
        );
        messaging = services.includes(messagingServiceName);
        if (services.includes(identityServiceName)) {
          name = (await loadContact(
            peer.service<IdentityService>(identityServiceName),
            props.session.storage().peer(peer.id).service(identityServiceName),
          )).name;
        }
      } catch {
        // A peer id is always available when remote services fail.
      }
    }

    return { peer, name, connected, messaging };
  }

  async function loadRoster(): Promise<readonly ListedPeer[]> {
    if (!active) return [];

    stopRoster ??= props.roster.subscribe(() => void refetch());
    return Promise.all((await props.roster.list()).map(describe));
  }

  const [roster, { refetch }] = createResource(loadRoster);
  const unavailable = () => actionBusy() || roster.loading;
  const peers = createMemo<readonly ListedPeer[] | undefined>((current) =>
    roster.error === undefined ? roster() : current,
  );

  async function performAction(operation: () => Promise<void>): Promise<void> {
    setActionError(undefined);
    setActionBusy(true);
    try {
      await operation();
    } catch (reason) {
      if (active) setActionError(errorMessage(reason));
    } finally {
      if (active) setActionBusy(false);
    }
  }

  async function connectAndOpen(peer: Peer): Promise<void> {
    const connected = await peer.connect();
    const services = validateServiceNames(
      await connected.service<Registry>(registryServiceName).list(),
    );
    if (!services.includes(messagingServiceName)) {
      throw new Error("This peer does not provide messaging.");
    }
    props.onOpenChat(connected.id);
  }

  async function connectDirect(
    event: SubmitEvent & { currentTarget: HTMLFormElement },
  ): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const address = String(new FormData(form).get("direct-address") ?? "").trim();
    await performAction(async () => {
      const network = await props.session.network();
      await connectAndOpen(await network.createPeer(address));
      form.reset();
    });
  }

  async function signOut(): Promise<void> {
    active = false;
    stopRoster?.();
    await props.session.close().catch(() => {});
    props.onSignedOut();
  }

  onCleanup(() => {
    active = false;
    stopRoster?.();
  });

  return (
    <section aria-labelledby="home-heading">
      <header>
        <h2 id="home-heading">Home</h2>
        <p>Signed in as {props.session.username}.</p>
      </header>
      <Show when={peers() !== undefined && props.session.bootstrapError()}>
        {(message) => <p role="alert">Peer networking is unavailable: {message()}</p>}
      </Show>
      <Show when={roster.error}>
        {(reason) => <p role="alert">{errorMessage(reason())}</p>}
      </Show>
      <Show when={actionError()}>{(message) => <p role="alert">{message()}</p>}</Show>

      <button
        class="secondary"
        type="button"
        disabled={unavailable()}
        onClick={() => {
          setActionError(undefined);
          void refetch();
        }}
      >
        Refresh peers
      </button>

      <section aria-labelledby="peers-heading">
        <h3 id="peers-heading">Peers</h3>
        <Show
          when={peers()}
          fallback={roster.loading
            ? <p aria-live="polite">Loading peers…</p>
            : <p>No peers are currently known.</p>}
        >
          {(listed) => (
            <Show when={listed().length > 0} fallback={<p>No peers are currently known.</p>}>
              <ul>
                <For each={listed()}>
                  {(peer) => (
                    <PeerRow
                      listed={peer}
                      session={props.session}
                      busy={unavailable()}
                      onConnect={(selected) => void performAction(
                        () => connectAndOpen(selected),
                      )}
                      onOpenChat={props.onOpenChat}
                    />
                  )}
                </For>
              </ul>
            </Show>
          )}
        </Show>
      </section>

      <details>
        <summary>Connect directly</summary>
        <form onSubmit={connectDirect}>
          <label for="direct-address">
            Peer multiaddress
            <input
              id="direct-address"
              name="direct-address"
              required
              placeholder="/dns4/example.com/tcp/9090/ws/p2p/..."
            />
          </label>
          <button type="submit" disabled={unavailable()}>Connect directly</button>
        </form>
      </details>

      <button
        type="button"
        class="secondary"
        disabled={unavailable()}
        onClick={() => void performAction(signOut)}
      >
        Sign out
      </button>
    </section>
  );
}

function PeerRow(props: {
  listed: ListedPeer;
  session: Session;
  busy: boolean;
  onConnect(peer: Peer): void;
  onOpenChat(peerId: string): void;
}) {
  const storage = props.session.storage().peer(props.listed.peer.id)
    .service(messagingServiceName);
  const events = storage.event<MessagingEvent>();
  const read = storage.singleton<number>("read");
  const [unread, setUnread] = createSignal(false);

  function updateUnread(): void {
    const received = events.read().filter((event) => event.type === "received").length;
    setUnread(received > (read.get() ?? 0));
  }

  const stops = [events.subscribe(updateUnread), read.subscribe(updateUnread)];
  updateUnread();
  onCleanup(() => stops.forEach((stop) => stop()));

  return (
    <li>
      <span
        classList={{ "connection-state": true, connected: props.listed.connected }}
        aria-label={props.listed.connected ? "Connected" : "Not connected"}
      />
      <strong>{props.listed.name}</strong>{" "}
      <Show when={unread()}>
        <span class="unread-state" aria-label="Unread messages" title="Unread messages">
          ●
        </span>{" "}
      </Show>
      <Show
        when={props.listed.connected}
        fallback={
          <button
            type="button"
            disabled={props.busy}
            onClick={() => props.onConnect(props.listed.peer)}
          >
            Connect
          </button>
        }
      >
        <Show when={props.listed.messaging} fallback={<small>Connected</small>}>
          <button
            type="button"
            onClick={() => props.onOpenChat(props.listed.peer.id)}
          >
            Chat
          </button>
        </Show>
      </Show>
    </li>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "An unexpected network error occurred.";
}
