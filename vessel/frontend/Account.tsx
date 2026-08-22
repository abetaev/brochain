import type { ZxcvbnFactory } from "@zxcvbn-ts/core";
import { For, Show, createResource, createSignal } from "solid-js";
import account from "@v/backend/account";
import type { Session } from "@v/backend/session";

type AccountScreen =
  | { readonly kind: "list" | "create" }
  | { readonly kind: "unlock"; readonly username: string };
type FormSubmitEvent = SubmitEvent & { currentTarget: HTMLFormElement };

const passwordStrengthLabels = ["Very weak", "Weak", "Fair", "Strong", "Very strong"];
let passwords: Promise<ZxcvbnFactory> | undefined;

async function loadPasswords(): Promise<ZxcvbnFactory> {
  const loading = passwords ??= initializePasswords();

  try {
    return await loading;
  } catch (error) {
    if (passwords === loading) passwords = undefined;
    throw error;
  }
}

async function initializePasswords(): Promise<ZxcvbnFactory> {
  const [{ ZxcvbnFactory }, common, english] = await Promise.all([
    import("@zxcvbn-ts/core"),
    import("@zxcvbn-ts/language-common"),
    import("@zxcvbn-ts/language-en"),
  ]);
  return new ZxcvbnFactory({
    dictionary: { ...common.dictionary, ...english.dictionary },
    graphs: common.adjacencyGraphs,
    translations: english.translations,
  });
}

export function Account(props: { onSignedIn(session: Session): void }) {
  const [screen, setScreen] = createSignal<AccountScreen>({ kind: "list" });
  const [creationPassword, setCreationPassword] = createSignal("");
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [accounts, { refetch }] = createResource(async () => {
    try {
      return await account.list();
    } catch (reason) {
      setError(errorMessage(reason));
      return [];
    }
  });
  const hasAccounts = () => (accounts()?.length ?? 0) > 0;
  const unlockUsername = () => {
    const current = screen();
    return current.kind === "unlock" ? current.username : undefined;
  };

  async function performMutation(operation: () => Promise<void>): Promise<void> {
    setError(undefined);
    setBusy(true);
    try {
      await operation();
    } catch (reason) {
      setError(errorMessage(reason));
    }
    setBusy(false);
  }

  function show(next: AccountScreen): void {
    setCreationPassword("");
    setError(undefined);
    setScreen(next);
  }

  async function createAccount(event: FormSubmitEvent): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const confirmation = String(data.get("password-confirmation") ?? "");
    const password = creationPassword();

    if (password !== confirmation) {
      setError("The password confirmation does not match.");
      return;
    }

    await performMutation(async () => {
      props.onSignedIn(await account.create(String(data.get("username") ?? ""), password));
    });
  }

  async function unlockAccount(
    event: FormSubmitEvent,
    username: string,
  ): Promise<void> {
    event.preventDefault();
    const password = String(
      new FormData(event.currentTarget).get("unlock-password") ?? "",
    );
    await performMutation(async () => {
      props.onSignedIn(await account.unlock(username, password));
    });
  }

  async function deleteAccount(
    event: FormSubmitEvent,
    username: string,
  ): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const password = String(new FormData(form).get("delete-password") ?? "");

    await performMutation(async () => {
      if (!await account.delete(username, password)) {
        setError("The password is incorrect.");
        return;
      }

      form.reset();
      await refetch();
    });
  }

  async function exportAccount(username: string): Promise<void> {
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

  return (
    <section aria-labelledby="account-heading">
      <h2 id="account-heading">Account</h2>

      <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
      <Show when={accounts() === undefined}>
        <p aria-live="polite">Loading accounts…</p>
      </Show>

      <Show when={
        accounts() !== undefined && (screen().kind === "create" || !hasAccounts())
      }>
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
                value={creationPassword()}
                onInput={(event) => setCreationPassword(event.currentTarget.value)}
              />
            </label>
            <PasswordStrength password={creationPassword()} />
            <label for="password-confirmation">
              Confirm password
              <input
                id="password-confirmation"
                name="password-confirmation"
                type="password"
                autocomplete="new-password"
                required
              />
            </label>
            <button type="submit" aria-busy={busy()} disabled={busy()}>
              Create account
            </button>
            <Show when={hasAccounts()}>
              <button
                class="secondary"
                type="button"
                disabled={busy()}
                onClick={() => show({ kind: "list" })}
              >
                Cancel
              </button>
            </Show>
          </form>
        </section>
      </Show>

      <Show when={accounts() !== undefined && screen().kind === "list" && hasAccounts()}>
        <section aria-labelledby="accounts-heading">
          <h3 id="accounts-heading">Choose an account</h3>
          <ul>
            <For each={accounts()}>
              {(username) => (
                <li>
                  <strong>{username}</strong>{" "}
                  <button
                    type="button"
                    disabled={busy()}
                    onClick={() => show({ kind: "unlock", username })}
                  >
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
          <button
            type="button"
            disabled={busy()}
            onClick={() => show({ kind: "create" })}
          >
            Create another account
          </button>
        </section>
      </Show>

      <Show when={unlockUsername()}>
        {(username) => (
          <section aria-labelledby="unlock-heading">
            <h3 id="unlock-heading">Unlock {username()}</h3>
            <form onSubmit={(event) => void unlockAccount(event, username())}>
              <label for="unlock-password">
                Password
                <input
                  id="unlock-password"
                  name="unlock-password"
                  type="password"
                  autocomplete="current-password"
                  required
                />
              </label>
              <button type="submit" aria-busy={busy()} disabled={busy()}>
                Unlock account
              </button>
              <button
                class="secondary"
                type="button"
                disabled={busy()}
                onClick={() => show({ kind: "list" })}
              >
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
  const [strength] = createResource(
    () => props.password || undefined,
    async (password) => {
      const score = (await loadPasswords()).check(password).score;
      return {
        level: Math.max(1, score),
        label: passwordStrengthLabels[score],
      };
    },
  );
  const current = () => {
    if (props.password.length === 0) return { level: 0, label: "Enter a password" };
    if (strength.loading) return { level: 0, label: "Checking…" };
    if (strength.error !== undefined) return { level: 0, label: "Unavailable" };
    return {
      level: strength()?.level ?? 0,
      label: strength()?.label ?? "Unavailable",
    };
  };
  const description = () => {
    if (current().label === "Checking…") return "Checking password strength…";
    if (current().label === "Unavailable") return "Password strength unavailable.";
    return `Password strength: ${current().label}`;
  };

  return (
    <div>
      <div
        class="password-strength"
        data-level={current().level}
        role="meter"
        aria-label={description()}
        aria-busy={strength.loading}
        aria-valuemin="0"
        aria-valuemax="4"
        aria-valuenow={current().level}
      >
        <For each={[1, 2, 3, 4]}>
          {(level) => <span classList={{ active: level <= current().level }} />}
        </For>
      </div>
      <small>{description()}</small>
    </div>
  );
}
