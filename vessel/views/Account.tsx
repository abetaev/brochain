import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import * as common from "@zxcvbn-ts/language-common";
import * as english from "@zxcvbn-ts/language-en";
import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import account from "@/services/account";
import type { Session } from "@/session";

type AccountMode = "list" | "create" | "unlock";

const passwordStrengthLabels = ["Very weak", "Weak", "Fair", "Strong", "Very strong"];
const passwords = new ZxcvbnFactory({
  dictionary: { ...common.dictionary, ...english.dictionary },
  graphs: common.adjacencyGraphs,
  translations: english.translations,
});

export function Account(props: { onSignedIn(session: Session): void }) {
  const [accounts, setAccounts] = createSignal<string[]>();
  const [mode, setMode] = createSignal<AccountMode>("list");
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [confirmation, setConfirmation] = createSignal("");
  const [selectedUsername, setSelectedUsername] = createSignal<string>();
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const hasAccounts = () => (accounts()?.length ?? 0) > 0;

  async function refreshAccounts() {
    try {
      setAccounts(await account.list());
    } catch (reason) {
      setAccounts([]);
      setError(errorMessage(reason));
    }
  }

  function resetForm() {
    setUsername("");
    setPassword("");
    setConfirmation("");
    setError(undefined);
  }

  function showAccountCreation() {
    resetForm();
    setMode("create");
  }

  function showAccountList() {
    resetForm();
    setSelectedUsername(undefined);
    setMode("list");
  }

  function showAccountUnlock(nextUsername: string) {
    resetForm();
    setSelectedUsername(nextUsername);
    setMode("unlock");
  }

  async function createAccount(event: SubmitEvent) {
    event.preventDefault();
    setError(undefined);

    if (password() !== confirmation()) {
      setError("The password confirmation does not match.");
      return;
    }

    setBusy(true);

    try {
      props.onSignedIn(await account.create(username(), password()));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function unlockAccount(event: SubmitEvent) {
    event.preventDefault();
    setError(undefined);
    const selected = selectedUsername();

    if (selected === undefined) {
      return;
    }

    setBusy(true);

    try {
      props.onSignedIn(await account.unlock(selected, password()));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount(
    event: SubmitEvent & { currentTarget: HTMLFormElement },
    username: string,
  ) {
    event.preventDefault();
    setError(undefined);
    const form = event.currentTarget;
    const value = new FormData(form).get("delete-password");
    setBusy(true);

    try {
      const deleted = await account.delete(username, typeof value === "string" ? value : "");

      if (!deleted) {
        setError("The password is incorrect.");
        return;
      }

      form.reset();
      await refreshAccounts();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function exportAccount(username: string) {
    setError(undefined);

    try {
      const contents = await account.export(username);
      const file = new Blob([contents], { type: "application/json" });
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${username}.brochain-account.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  onMount(() => void refreshAccounts());

  return (
    <section aria-labelledby="account-heading">
      <h2 id="account-heading">Account</h2>

      <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
      <Show when={accounts() === undefined}>
        <p aria-live="polite">Loading accounts…</p>
      </Show>

      <Show when={accounts() !== undefined && (mode() === "create" || !hasAccounts())}>
        <section aria-labelledby="registration-heading">
          <h3 id="registration-heading">Create an account</h3>
          <form onSubmit={createAccount}>
            <label for="username">
              Username
              <input
                id="username"
                name="username"
                autocomplete="username"
                pattern="[a-z]{1,64}"
                title="Use 1 to 64 lowercase English letters."
                required
                value={username()}
                onInput={(event) => setUsername(event.currentTarget.value)}
              />
            </label>
            <label for="new-password">
              Password
              <input
                id="new-password"
                name="new-password"
                type="password"
                autocomplete="new-password"
                required
                value={password()}
                onInput={(event) => setPassword(event.currentTarget.value)}
              />
            </label>
            <PasswordStrength password={password()} />
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
            <button type="submit" aria-busy={busy()} disabled={busy()}>
              Create account
            </button>
            <Show when={hasAccounts()}>
              <button class="secondary" type="button" disabled={busy()} onClick={showAccountList}>
                Cancel
              </button>
            </Show>
          </form>
        </section>
      </Show>

      <Show when={accounts() !== undefined && mode() === "list" && hasAccounts()}>
        <section aria-labelledby="accounts-heading">
          <h3 id="accounts-heading">Choose an account</h3>
          <ul>
            <For each={accounts()}>
              {(username) => (
                <li>
                  <strong>{username}</strong>{" "}
                  <button type="button" disabled={busy()} onClick={() => showAccountUnlock(username)}>
                    Use
                  </button>{" "}
                  <button
                    type="button"
                    class="secondary"
                    disabled={busy()}
                    onClick={() => void exportAccount(username)}
                  >
                    Export
                  </button>{" "}
                  <details>
                    <summary>Delete</summary>
                    <form onSubmit={(event) => void deleteAccount(event, username)}>
                      <label>
                        Password
                        <input
                          name="delete-password"
                          type="password"
                          autocomplete="current-password"
                          required
                        />
                      </label>
                      <button class="contrast" type="submit" disabled={busy()}>
                        Delete account
                      </button>
                    </form>
                  </details>
                </li>
              )}
            </For>
          </ul>
          <button type="button" disabled={busy()} onClick={showAccountCreation}>
            Create another account
          </button>
        </section>
      </Show>

      <Show when={mode() === "unlock" && selectedUsername()}>
        {(username) => (
          <section aria-labelledby="unlock-heading">
            <h3 id="unlock-heading">Unlock {username()}</h3>
            <form onSubmit={unlockAccount}>
              <label for="unlock-password">
                Password
                <input
                  id="unlock-password"
                  name="unlock-password"
                  type="password"
                  autocomplete="current-password"
                  required
                  value={password()}
                  onInput={(event) => setPassword(event.currentTarget.value)}
                />
              </label>
              <button type="submit" aria-busy={busy()} disabled={busy()}>
                Unlock account
              </button>
              <button class="secondary" type="button" disabled={busy()} onClick={showAccountList}>
                Cancel
              </button>
            </form>
          </section>
        )}
      </Show>
    </section>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "An unexpected account error occurred.";
}

function PasswordStrength(props: { password: string }) {
  const strength = createMemo(() => {
    if (props.password.length === 0) {
      return { level: 0, label: "Enter a password" };
    }

    const score = passwords.check(props.password).score;
    return {
      level: Math.max(1, score),
      label: passwordStrengthLabels[score] ?? passwordStrengthLabels[0],
    };
  });

  return (
    <div>
      <div
        class="password-strength"
        data-level={strength().level}
        role="meter"
        aria-label={`Password strength: ${strength().label}`}
        aria-valuemin="0"
        aria-valuemax="4"
        aria-valuenow={strength().level}
      >
        <For each={[1, 2, 3, 4]}>
          {(level) => <span classList={{ active: level <= strength().level }} />}
        </For>
      </div>
      <small>Password strength: {strength().label}</small>
    </div>
  );
}
