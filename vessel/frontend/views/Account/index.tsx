import { Show, createResource, createSignal } from "solid-js";
import account from "@v/backend/account";
import type { Session } from "@v/backend/session";
import { Delete } from "./Delete";
import { Select } from "./Select";
import { SignIn } from "./SignIn";
import { SignUp } from "./SignUp";

type AccountScreen =
  | { readonly kind: "signup" | "select" }
  | { readonly kind: "signin"; readonly username: string }
  | { readonly kind: "delete"; readonly username: string };
export type FormSubmitEvent = SubmitEvent & { currentTarget: HTMLFormElement };

// The account views share one set of accounts, one busy flag and one error, so
// that state lives here and each view stays a view.
export function Account(props: { onSignedIn(session: Session): Promise<void> }) {
  const [screen, setScreen] = createSignal<AccountScreen>({ kind: "select" });
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
  const at = <Kind extends AccountScreen["kind"]>(kind: Kind) => () => {
    const current = screen();
    return current.kind === kind ? current as Extract<AccountScreen, { kind: Kind }> : undefined;
  };
  const signingIn = at("signin");
  const deleting = at("delete");

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
    const data = new FormData(event.currentTarget);
    const confirmation = String(data.get("password-confirmation") ?? "");
    const password = creationPassword();

    if (password !== confirmation) {
      setError("The password confirmation does not match.");
      return;
    }

    await performMutation(async () => {
      await props.onSignedIn(
        await account.create(String(data.get("username") ?? ""), password),
      );
    });
  }

  async function unlockAccount(event: FormSubmitEvent, username: string): Promise<void> {
    event.preventDefault();
    const password = String(
      new FormData(event.currentTarget).get("unlock-password") ?? "",
    );
    await performMutation(async () => {
      await props.onSignedIn(await account.unlock(username, password));
    });
  }

  async function deleteAccount(event: FormSubmitEvent, username: string): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const password = String(new FormData(form).get("delete-password") ?? "");

    await performMutation(async () => {
      if (!await account.delete(username, password)) {
        setError("The password is incorrect.");
        return;
      }

      form.reset();
      show({ kind: "select" });
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
    <Show when={accounts() !== undefined} fallback={<p aria-live="polite">Loading accounts…</p>}>
      {/* With no account yet there is nothing to choose between, so signing up
          is the only place to be. */}
      <Show when={screen().kind === "signup" || !hasAccounts()}>
        <SignUp
          canCancel={hasAccounts()}
          busy={busy()}
          error={error()}
          password={creationPassword()}
          onPasswordInput={setCreationPassword}
          onSubmit={createAccount}
          onCancel={() => show({ kind: "select" })}
        />
      </Show>
      <Show when={screen().kind === "select" && hasAccounts()}>
        <Select
          accounts={accounts() ?? []}
          busy={busy()}
          error={error()}
          onSignIn={(username) => show({ kind: "signin", username })}
          onExport={(username) => void exportAccount(username)}
          onDelete={(username) => show({ kind: "delete", username })}
          onCreate={() => show({ kind: "signup" })}
        />
      </Show>
      <Show when={signingIn()}>
        {(current) => (
          <SignIn
            username={current().username}
            busy={busy()}
            error={error()}
            onSubmit={(event) => void unlockAccount(event, current().username)}
            onBack={() => show({ kind: "select" })}
          />
        )}
      </Show>
      <Show when={deleting()}>
        {(current) => (
          <Delete
            username={current().username}
            busy={busy()}
            error={error()}
            onSubmit={(event) => void deleteAccount(event, current().username)}
            onBack={() => show({ kind: "select" })}
          />
        )}
      </Show>
    </Show>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "An unexpected account error occurred.";
}
