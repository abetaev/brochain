import { Show } from "solid-js";
import type { Action } from "@v/frontend/components/ActionBar";
import { Avatar } from "@v/frontend/components/Avatar";
import { TextField } from "@v/frontend/components/TextField";
import { Handheld } from "@v/frontend/layouts/Handheld";
import type { FormSubmitEvent } from "./index";
import "./identity.css";

export function SignIn(props: {
  username: string;
  /** Whether this device holds a wrapping for the account, and so can be offered. */
  authenticator: boolean;
  busy: boolean;
  error: string | undefined;
  onSubmit(event: FormSubmitEvent): void;
  onAuthenticator(): void;
  onBack(): void;
}) {
  const actions = (): Action[] => [
    { side: "start", icon: "👈", label: "Back", disabled: props.busy, onClick: props.onBack },
    {
      side: "end",
      icon: "👍",
      label: "Unlock account",
      variant: "primary",
      type: "submit",
      busy: props.busy,
      disabled: props.busy,
    },
  ];

  return (
    <Handheld icon="✌️" title="Sign In" actions={actions()} onSubmit={props.onSubmit}>
      <Show when={props.error}>{(message) => <p role="alert">{message()}</p>}</Show>
      {/* The figure takes the free space and centres the account in it, which
          leaves the field at the bottom of the content, above the bar. */}
      <figure class="identity">
        <Avatar seed={props.username} name={props.username} size="lg" />
        <figcaption>{props.username}</figcaption>
      </figure>
      {/* The ceremony already ran when the screen opened; this is what a reader
          who dismissed it needs to reach it again. */}
      <Show when={props.authenticator}>
        <button
          class="text-button"
          type="button"
          disabled={props.busy}
          onClick={props.onAuthenticator}
        >
          Try this device again
        </button>
      </Show>
      <TextField
        id="unlock-password"
        name="unlock-password"
        label="Password"
        type="password"
        autocomplete="current-password"
        required
      />
    </Handheld>
  );
}
