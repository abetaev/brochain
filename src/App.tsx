import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { passwordStrength } from "./accounts/password";
import { createIndexedDbAccountRepository } from "./accounts/repository";
import { AccountService } from "./accounts/service";
import type { StoredAccount, UnlockedAccount } from "./accounts/types";
import type { DiscoveredPeer, PeerNetworkController } from "./network/client";
import type { PeerPacket } from "./network/protocol";

type View = "accounts" | "create" | "unlock";

export interface AppProps {
  accountService?: AccountService;
  createPeerNetwork?: () => PeerNetworkController;
}

interface ChatEntry {
  direction: "received" | "sent";
  peerId: string;
  packet: PeerPacket;
}

function ChatEntryView(props: { entry: ChatEntry }) {
  const packet = props.entry.packet;

  return (
    <article>
      <header>{props.entry.direction === "sent" ? "You" : props.entry.peerId}</header>
      {packet.type === "text" ? (
        <p>{packet.text}</p>
      ) : (
        <p>
          <a download={packet.name} href={`data:${packet.mediaType};base64,${packet.data}`}>
            Download {packet.name}
          </a>
        </p>
      )}
    </article>
  );
}

export function App(props: AppProps) {
  const accountService = props.accountService ?? new AccountService(createIndexedDbAccountRepository());
  const [accounts, setAccounts] = createSignal<StoredAccount[] | undefined>();
  const [view, setView] = createSignal<View>("accounts");
  const [selectedAccount, setSelectedAccount] = createSignal<StoredAccount>();
  const [session, setSession] = createSignal<UnlockedAccount>();
  const [network, setNetwork] = createSignal<PeerNetworkController>();
  const [peers, setPeers] = createSignal<DiscoveredPeer[]>([]);
  const [activePeer, setActivePeer] = createSignal<DiscoveredPeer>();
  const [chatEntries, setChatEntries] = createSignal<ChatEntry[]>([]);
  const [directAddress, setDirectAddress] = createSignal("");
  const [createName, setCreateName] = createSignal("");
  const [createPassword, setCreatePassword] = createSignal("");
  const [confirmation, setConfirmation] = createSignal("");
  const [unlockPassword, setUnlockPassword] = createSignal("");
  const [error, setError] = createSignal<string>();
  const [isBusy, setIsBusy] = createSignal(false);
  const strength = createMemo(() => passwordStrength(createPassword()));
  let removeNetworkListener: (() => void) | undefined;

  async function refreshAccounts() {
    try {
      const storedAccounts = await accountService.list();
      setAccounts(storedAccounts);

      if (storedAccounts.length === 0) {
        setView("create");
      }
    } catch (reason) {
      setError(AccountService.errorMessage(reason));
      setAccounts([]);
    }
  }

  onMount(() => {
    void refreshAccounts();
  });

  onCleanup(() => {
    void stopPeerNetwork();
  });

  function resetCreateForm() {
    setCreateName("");
    setCreatePassword("");
    setConfirmation("");
  }

  function showCreateAccount() {
    setError(undefined);
    resetCreateForm();
    setView("create");
  }

  function showAccountList() {
    setError(undefined);
    setSelectedAccount(undefined);
    setUnlockPassword("");
    setView("accounts");
  }

  async function createAccount(event: Event) {
    event.preventDefault();
    setError(undefined);

    if (createPassword() !== confirmation()) {
      setError("The password confirmation does not match.");
      return;
    }

    setIsBusy(true);

    try {
      await accountService.create(createName(), createPassword());
      await refreshAccounts();
      resetCreateForm();
      setView("accounts");
    } catch (reason) {
      setError(AccountService.errorMessage(reason));
    } finally {
      setIsBusy(false);
    }
  }

  function selectAccount(account: StoredAccount) {
    setError(undefined);
    setSelectedAccount(account);
    setUnlockPassword("");
    setView("unlock");
  }

  async function unlockAccount(event: Event) {
    event.preventDefault();
    const account = selectedAccount();

    if (account === undefined) {
      return;
    }

    setError(undefined);
    setIsBusy(true);

    try {
      const unlockedAccount = await accountService.unlock(account.id, unlockPassword());
      setSession(unlockedAccount);
      setUnlockPassword("");

      try {
        await startPeerNetwork(unlockedAccount);
      } catch (reason) {
        setError(`Account unlocked, but peer networking is unavailable: ${AccountService.errorMessage(reason)}`);
      }
    } catch (reason) {
      setError(AccountService.errorMessage(reason));
    } finally {
      setIsBusy(false);
    }
  }

  async function deleteAccount(account: StoredAccount) {
    setError(undefined);
    setIsBusy(true);

    try {
      await accountService.remove(account.id);
      await refreshAccounts();
    } catch (reason) {
      setError(AccountService.errorMessage(reason));
    } finally {
      setIsBusy(false);
    }
  }

  async function exportAccount(account: StoredAccount) {
    setError(undefined);

    try {
      const contents = await accountService.export(account.id);
      const file = new Blob([contents], { type: "application/json" });
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${account.name}.brochain-account.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(AccountService.errorMessage(reason));
    }
  }

  function addChatEntry(direction: ChatEntry["direction"], peerId: string, packet: PeerPacket) {
    setChatEntries((entries) => [...entries, { direction, peerId, packet }]);
  }

  async function startPeerNetwork(account: UnlockedAccount) {
    await stopPeerNetwork();
    const nextNetwork =
      props.createPeerNetwork === undefined
        ? new (await import("./network/client")).PeerNetwork()
        : await props.createPeerNetwork();
    const removeListener = nextNetwork.onPacket(({ peerId, packet }) => {
      addChatEntry("received", peerId, packet);
    });

    try {
      await nextNetwork.start(account.secrets, account.name);
      removeNetworkListener = removeListener;
      setNetwork(nextNetwork);
      await refreshPeers(nextNetwork);
    } catch (reason) {
      removeListener();
      await nextNetwork.stop();
      throw reason;
    }
  }

  async function stopPeerNetwork() {
    removeNetworkListener?.();
    removeNetworkListener = undefined;
    const currentNetwork = network();
    setNetwork(undefined);
    setPeers([]);
    setActivePeer(undefined);

    if (currentNetwork !== undefined) {
      await currentNetwork.stop();
    }
  }

  async function refreshPeers(peerNetwork = network()) {
    if (peerNetwork === undefined) {
      return;
    }

    try {
      setPeers(await peerNetwork.peers());
    } catch (reason) {
      setError(AccountService.errorMessage(reason));
    }
  }

  async function connectPeer(peer: DiscoveredPeer) {
    const peerNetwork = network();

    if (peerNetwork === undefined) {
      return;
    }

    setError(undefined);
    setIsBusy(true);

    try {
      await peerNetwork.connect(peer);
      setActivePeer(peer);
    } catch (reason) {
      setError(AccountService.errorMessage(reason));
    } finally {
      setIsBusy(false);
    }
  }

  async function connectDirectly(event: Event) {
    event.preventDefault();
    const peerNetwork = network();

    if (peerNetwork === undefined) {
      return;
    }

    setError(undefined);
    setIsBusy(true);

    try {
      const peer = await peerNetwork.connectDirect(directAddress());
      setActivePeer(peer);
      setDirectAddress("");
    } catch (reason) {
      setError(AccountService.errorMessage(reason));
    } finally {
      setIsBusy(false);
    }
  }

  async function sendMessage(event: Event) {
    event.preventDefault();
    const peerNetwork = network();
    const peer = activePeer();

    if (peerNetwork === undefined || peer === undefined) {
      return;
    }

    setError(undefined);
    setIsBusy(true);

    try {
      const packet = await peerNetwork.sendText(peer, message());
      addChatEntry("sent", peer.peerId, packet);
      setMessage("");
    } catch (reason) {
      setError(AccountService.errorMessage(reason));
    } finally {
      setIsBusy(false);
    }
  }

  async function sendFile(event: Event & { currentTarget: HTMLInputElement }) {
    const file = event.currentTarget.files?.[0];
    const peerNetwork = network();
    const peer = activePeer();

    if (file === undefined || peerNetwork === undefined || peer === undefined) {
      return;
    }

    setError(undefined);
    setIsBusy(true);

    try {
      const packet = await peerNetwork.sendFile(peer, file);
      addChatEntry("sent", peer.peerId, packet);
      event.currentTarget.value = "";
    } catch (reason) {
      setError(AccountService.errorMessage(reason));
    } finally {
      setIsBusy(false);
    }
  }

  async function signOut() {
    await stopPeerNetwork();
    setSession(undefined);
    showAccountList();
  }

  const [message, setMessage] = createSignal("");

  return (
    <main class="container">
      <header>
        <hgroup>
          <h1>brochain</h1>
          <p>Private peer-to-peer communication.</p>
        </hgroup>
      </header>

      <Show when={error()}>
        {(message) => <p role="alert">{message()}</p>}
      </Show>

      <Show when={accounts() === undefined}>
        <p aria-live="polite">Loading accounts…</p>
      </Show>

      <Show when={accounts() !== undefined && session() === undefined}>
        <Show when={view() === "create"}>
          <section aria-labelledby="create-account-heading">
            <h2 id="create-account-heading">Create an account</h2>
            <p>This device has no accounts yet. Create one to begin.</p>

            <form onSubmit={createAccount}>
              <label for="account-name">
                Account name
                <input
                  id="account-name"
                  name="account-name"
                  autocomplete="username"
                  required
                  value={createName()}
                  onInput={(event) => setCreateName(event.currentTarget.value)}
                />
              </label>

              <label for="password">
                Password
                <input
                  id="password"
                  name="password"
                  type="password"
                  autocomplete="new-password"
                  required
                  value={createPassword()}
                  onInput={(event) => setCreatePassword(event.currentTarget.value)}
                />
              </label>

              <label for="password-confirmation">
                Confirm password
                <input
                  id="password-confirmation"
                  name="password-confirmation"
                  type="password"
                  autocomplete="new-password"
                  required
                  value={confirmation()}
                  onInput={(event) => setConfirmation(event.currentTarget.value)}
                />
              </label>

              <label for="password-strength">
                Password strength: {strength().label}
                <meter id="password-strength" min="0" max="4" value={strength().score}>
                  {strength().label}
                </meter>
              </label>

              <button type="submit" aria-busy={isBusy()} disabled={isBusy()}>
                Create account
              </button>
              <Show when={(accounts()?.length ?? 0) > 0}>
                <button class="secondary" type="button" onClick={showAccountList}>
                  Cancel
                </button>
              </Show>
            </form>
          </section>
        </Show>

        <Show when={view() === "accounts" && (accounts()?.length ?? 0) > 0}>
          <section aria-labelledby="accounts-heading">
            <h2 id="accounts-heading">Choose an account</h2>
            <ul>
              <For each={accounts()}>
                {(account) => (
                  <li>
                    <strong>{account.name}</strong>{" "}
                    <button type="button" onClick={() => selectAccount(account)}>
                      Use
                    </button>{" "}
                    <button class="secondary" type="button" onClick={() => void exportAccount(account)}>
                      Export
                    </button>{" "}
                    <button
                      class="contrast"
                      type="button"
                      disabled={isBusy()}
                      onClick={() => void deleteAccount(account)}
                    >
                      Delete
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <button type="button" onClick={showCreateAccount}>
              Create another account
            </button>
          </section>
        </Show>

        <Show when={view() === "unlock" && selectedAccount()}>
          {(account) => (
            <section aria-labelledby="unlock-account-heading">
              <h2 id="unlock-account-heading">Unlock {account().name}</h2>
              <form onSubmit={unlockAccount}>
                <label for="unlock-password">
                  Password
                  <input
                    id="unlock-password"
                    name="unlock-password"
                    type="password"
                    autocomplete="current-password"
                    required
                    value={unlockPassword()}
                    onInput={(event) => setUnlockPassword(event.currentTarget.value)}
                  />
                </label>
                <button type="submit" aria-busy={isBusy()} disabled={isBusy()}>
                  Unlock account
                </button>
                <button class="secondary" type="button" onClick={showAccountList}>
                  Cancel
                </button>
              </form>
            </section>
          )}
        </Show>
      </Show>

      <Show when={session()}>
        {(account) => (
          <section aria-labelledby="account-ready-heading">
            <h2 id="account-ready-heading">Welcome, {account().name}</h2>
            <p>Your account is unlocked as peer {account().secrets.peerId}.</p>

            <Show
              when={network()}
              fallback={
                <p>
                  Peer networking is unavailable. <button type="button" onClick={() => void startPeerNetwork(account())}>Retry</button>
                </p>
              }
            >
              <section aria-labelledby="peers-heading">
                <h3 id="peers-heading">Discoverable peers</h3>
                <button type="button" class="secondary" onClick={() => void refreshPeers()}>
                  Refresh peers
                </button>

                <Show when={peers().length > 0} fallback={<p>No peers are currently discoverable.</p>}>
                  <ul>
                    <For each={peers()}>
                      {(peer) => (
                        <li>
                          <strong>{peer.name}</strong>{" "}
                          <button type="button" disabled={isBusy()} onClick={() => void connectPeer(peer)}>
                            Connect
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>

                <details>
                  <summary>Connect directly</summary>
                  <form onSubmit={connectDirectly}>
                    <label for="direct-address">
                      Peer multiaddress
                      <input
                        id="direct-address"
                        placeholder="/dns4/example.com/tcp/9090/ws/p2p/.../p2p-circuit/webrtc/p2p/..."
                        required
                        value={directAddress()}
                        onInput={(event) => setDirectAddress(event.currentTarget.value)}
                      />
                    </label>
                    <button type="submit" disabled={isBusy()}>
                      Connect directly
                    </button>
                  </form>
                </details>
              </section>

              <Show when={activePeer()}>
                {(peer) => (
                  <section aria-labelledby="chat-heading">
                    <h3 id="chat-heading">Chat with {peer().name}</h3>
                    <For each={chatEntries().filter((entry) => entry.peerId === peer().peerId)}>
                      {(entry) => <ChatEntryView entry={entry} />}
                    </For>
                    <form onSubmit={sendMessage}>
                      <label for="message">
                        Message
                        <input
                          id="message"
                          value={message()}
                          onInput={(event) => setMessage(event.currentTarget.value)}
                        />
                      </label>
                      <button type="submit" disabled={isBusy()}>
                        Send message
                      </button>
                    </form>
                    <label for="file">
                      Send a file
                      <input id="file" type="file" disabled={isBusy()} onChange={(event) => void sendFile(event)} />
                    </label>
                  </section>
                )}
              </Show>
            </Show>

            <button type="button" onClick={() => void signOut()}>
              Sign out
            </button>
          </section>
        )}
      </Show>
    </main>
  );
}
