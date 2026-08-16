import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import {
  registryServiceName,
  type Peer,
  type RegistryService,
} from "../../common/network/index.ts";
import {
  identityServiceName,
  type IdentityDefinition,
} from "@/network/services/identity";
import {
  messagingServiceName,
  type MessagingEvent,
} from "@/network/services/messaging";
import type { Session } from "@/session";

interface ListedPeer {
  readonly peer: Peer;
  readonly name: string;
  readonly connected: boolean;
  readonly messaging: boolean;
  readonly unread: boolean;
}

export function Home(props: {
  session: Session;
  onOpenChat(peerId: string): void;
  onSignedOut(): void;
}) {
  const [directAddress, setDirectAddress] = createSignal("");
  const [peers, setPeers] = createSignal<readonly ListedPeer[]>([]);
  const [error, setError] = createSignal<string>();
  const [bootstrapError, setBootstrapError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const observers = new Map<string, () => void>();
  let stopObservingRoster: (() => void) | undefined;
  let refreshVersion = 0;
  let operations = 0;
  let active = true;

  function beginOperation(): void {
    operations += 1;
    setBusy(true);
  }

  function endOperation(): void {
    operations -= 1;
    if (active && operations === 0) setBusy(false);
  }

  function unread(peer: Peer): boolean {
    const storage = props.session.storage(peer);
    const received = storage.events<MessagingEvent>(messagingServiceName).read()
      .filter((event) => event.type === "received").length;
    const read = storage.value<number>(messagingServiceName, "read").get() ?? 0;
    return received > read;
  }

  function updateUnread(peer: Peer): void {
    if (!active) return;
    setPeers((current) => current.map((listed) => listed.peer.id === peer.id
      ? { ...listed, unread: unread(peer) }
      : listed));
  }

  function observe(current: readonly ListedPeer[]): void {
    const currentIds = new Set(current.map(({ peer }) => peer.id));
    for (const [id, stop] of observers) {
      if (currentIds.has(id)) continue;
      stop();
      observers.delete(id);
    }

    for (const { peer } of current) {
      if (observers.has(peer.id)) continue;
      const storage = props.session.storage(peer);
      const stopEvents = storage.events<MessagingEvent>(messagingServiceName)
        .subscribe(() => updateUnread(peer));
      const stopRead = storage.value<number>(messagingServiceName, "read")
        .subscribe(() => updateUnread(peer));
      observers.set(peer.id, () => {
        stopEvents();
        stopRead();
      });
    }
  }

  async function describe(peer: Peer): Promise<ListedPeer> {
    const connected = peer.isConnected();
    let name = peer.id;
    let messaging = false;

    if (connected) {
      try {
        const services = await peer
          .service<RegistryService>(registryServiceName)
          .list();
        messaging = services.includes(messagingServiceName);
        if (services.includes(identityServiceName)) {
          try {
            name = (await peer
              .service<IdentityDefinition>(identityServiceName)
              .get()).name;
          } catch {
            // A peer id is always available as the display fallback.
          }
        }
      } catch {
        // A connected peer may stop responding while the roster refreshes.
      }
    }

    return { peer, name, connected, messaging, unread: unread(peer) };
  }

  async function refresh(): Promise<void> {
    const version = ++refreshVersion;
    const roster = await props.session.roster();
    if (stopObservingRoster === undefined && active) {
      stopObservingRoster = roster.subscribe(() => void refreshIgnoringErrors());
    }
    const listed = await Promise.all((await roster.list()).map(describe));
    if (!active || version !== refreshVersion) return;

    setBootstrapError(props.session.bootstrapError());
    setPeers(listed);
    observe(listed);
  }

  async function refreshIgnoringErrors(): Promise<void> {
    try {
      await refresh();
    } catch {
      // A newer manual refresh can still recover from a transient topology race.
    }
  }

  async function perform(work: () => Promise<void>): Promise<void> {
    beginOperation();
    setError(undefined);
    try {
      await work();
    } catch (reason) {
      if (active) {
        setBootstrapError(props.session.bootstrapError());
        setError(errorMessage(reason));
      }
    } finally {
      endOperation();
    }
  }

  async function openChat(peer: Peer): Promise<void> {
    await peer.connect();
    const services = await peer
      .service<RegistryService>(registryServiceName)
      .list();
    if (!services.includes(messagingServiceName)) {
      throw new Error("This peer does not provide messaging.");
    }
    await refresh();
    props.onOpenChat(peer.id);
  }

  async function connectDirect(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await perform(async () => {
      const network = await props.session.network();
      const peer = await network.createPeer(directAddress().trim());
      await openChat(peer);
      setDirectAddress("");
    });
  }

  async function signOut(): Promise<void> {
    active = false;
    beginOperation();
    try {
      await props.session.close();
    } finally {
      props.onSignedOut();
    }
  }

  onMount(() => void perform(refresh));
  onCleanup(() => {
    active = false;
    refreshVersion += 1;
    stopObservingRoster?.();
    for (const stop of observers.values()) stop();
    observers.clear();
  });

  return (
    <section aria-labelledby="home-heading">
      <header>
        <h2 id="home-heading">Home</h2>
        <p>Signed in as {props.session.username}.</p>
      </header>
      <Show when={bootstrapError()}>
        {(message) => <p role="alert">Peer networking is unavailable: {message()}</p>}
      </Show>
      <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>

      <button
        class="secondary"
        type="button"
        disabled={busy()}
        onClick={() => void perform(refresh)}
      >
        Retry bootstrap
      </button>{" "}
      <button
        class="secondary"
        type="button"
        disabled={busy()}
        onClick={() => void perform(refresh)}
      >
        Refresh peers
      </button>

      <section aria-labelledby="peers-heading">
        <h3 id="peers-heading">Peers</h3>
        <Show when={peers().length > 0} fallback={<p>No peers are currently known.</p>}>
          <ul>
            <For each={peers()}>
              {(listed) => (
                <li>
                  <span
                    classList={{ "connection-state": true, connected: listed.connected }}
                    aria-label={listed.connected ? "Connected" : "Not connected"}
                  />
                  <strong>{listed.name}</strong>{" "}
                  <Show when={listed.unread}>
                    <span class="unread-state" aria-label="Unread messages" title="Unread messages">
                      ●
                    </span>{" "}
                  </Show>
                  <Show
                    when={listed.connected}
                    fallback={
                      <button
                        type="button"
                        disabled={busy()}
                        onClick={() => void perform(async () => await openChat(listed.peer))}
                      >
                        Connect
                      </button>
                    }
                  >
                    <Show when={listed.messaging} fallback={<small>Connected</small>}>
                      <button type="button" onClick={() => props.onOpenChat(listed.peer.id)}>
                        Chat
                      </button>
                    </Show>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <details>
        <summary>Connect directly</summary>
        <form onSubmit={connectDirect}>
          <label for="direct-address">
            Peer multiaddress
            <input
              id="direct-address"
              required
              placeholder="/dns4/example.com/tcp/9090/ws/p2p/..."
              value={directAddress()}
              onInput={(event) => setDirectAddress(event.currentTarget.value)}
            />
          </label>
          <button type="submit" disabled={busy()}>Connect directly</button>
        </form>
      </details>

      <button type="button" class="secondary" disabled={busy()} onClick={() => void signOut()}>
        Sign out
      </button>
    </section>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "An unexpected network error occurred.";
}
