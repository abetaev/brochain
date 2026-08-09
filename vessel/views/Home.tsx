import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import type { Peer } from "../../common/network.ts";
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
  readMessages(peerId: string): number;
  onOpenChat(peer: Peer): void;
  onSignedOut(): void;
}) {
  const { network, registry, identity, messaging } = props.session;
  const [directAddress, setDirectAddress] = createSignal("");
  const [peers, setPeers] = createSignal<readonly ListedPeer[]>([]);
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const names = new Map<string, string>();
  const receivedMessages = new Map<string, number>();
  const observers = new Map<string, Array<() => void>>();
  const loadingNames = new Set<string>();
  let active = true;
  let networkReady = false;
  const stopObservingRegistry = registry.subscribe((peer) => {
    observePeers();
    if (networkReady && peer.isConnected()) void discoverPeerServices();
  });

  function update(): void {
    if (!active) return;
    setPeers(registry.peers.map((peer) => ({
      peer,
      name: names.get(peer.id) ?? peer.id,
      connected: peer.isConnected(),
      messaging: peer.services.includes("messaging"),
      unread: (receivedMessages.get(peer.id) ?? 0) > props.readMessages(peer.id),
    })));
  }

  function observePeers(): void {
    for (const peer of registry.peers) {
      if (!observers.has(peer.id)) {
        const stops: Array<() => void> = [];
        observers.set(peer.id, stops);
        stops.push(peer.subscribe((event) => {
          update();
          if (event === "connected" && networkReady) void discoverPeerServices();
        }));
        stops.push(messaging.instance(peer).subscribe((events) => {
          receivedMessages.set(
            peer.id,
            events.filter((event) => event.type === "received").length,
          );
          update();
        }));
      }
      if (peer.isConnected() && peer.services.includes("identity")) {
        void loadName(peer);
      }
    }
    update();
  }

  async function loadName(peer: Peer): Promise<void> {
    if (names.has(peer.id) || loadingNames.has(peer.id)) return;
    loadingNames.add(peer.id);
    try {
      names.set(peer.id, (await identity.instance(peer).get()).name);
      update();
    } catch {
      // The peer id remains its display fallback.
    } finally {
      loadingNames.delete(peer.id);
    }
  }

  async function discoverPeerServices(): Promise<void> {
    try {
      await registry.discover(true);
      observePeers();
    } catch {
      // Session closure makes pending discovery irrelevant.
    }
  }

  async function connectToNetwork(force = false): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await network.bootstrap();
      networkReady = true;
      await registry.discover(force);
      observePeers();
    } catch (reason) {
      if (active) {
        observePeers();
        setError(`Peer networking is unavailable: ${errorMessage(reason)}`);
      }
    } finally {
      if (active) setBusy(false);
    }
  }

  async function perform(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (reason) {
      if (active) setError(errorMessage(reason));
    } finally {
      if (active) setBusy(false);
    }
  }

  async function connect(peer: Peer): Promise<void> {
    await peer.connect();
    await registry.discover(true);
    observePeers();
    if (!peer.services.includes("messaging")) {
      throw new Error("This peer does not provide messaging.");
    }
    props.onOpenChat(peer);
  }

  async function connectDirect(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await perform(async () => {
      const peer = registry.add(directAddress().trim());
      await connect(peer);
      setDirectAddress("");
    });
  }

  async function signOut(): Promise<void> {
    active = false;
    setBusy(true);
    try {
      await props.session.close();
    } finally {
      props.onSignedOut();
    }
  }

  onMount(() => void connectToNetwork());
  onCleanup(() => {
    active = false;
    stopObservingRegistry();
    for (const stops of observers.values()) {
      for (const stop of stops) stop();
    }
  });

  return (
    <section aria-labelledby="home-heading">
      <header>
        <h2 id="home-heading">Home</h2>
        <p>Signed in as {props.session.username}.</p>
      </header>
      <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>

      <button
        class="secondary"
        type="button"
        disabled={busy()}
        onClick={() => void connectToNetwork(true)}
      >
        Retry bootstrap
      </button>{" "}
      <button
        class="secondary"
        type="button"
        disabled={busy()}
        onClick={() => void perform(async () => {
          await registry.discover(true);
          observePeers();
        })}
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
                        onClick={() => void perform(async () => await connect(listed.peer))}
                      >
                        Connect
                      </button>
                    }
                  >
                    <Show when={listed.messaging} fallback={<small>Connected</small>}>
                      <button type="button" onClick={() => props.onOpenChat(listed.peer)}>
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
