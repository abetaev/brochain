import { Show } from "solid-js";
import { Card } from "@v/frontend/components/Card";
import { PasswordStrength } from "@v/frontend/components/PasswordStrength";
import { TextField } from "@v/frontend/components/TextField";
import type { Action } from "@v/frontend/components/ActionBar";
import { Handheld } from "@v/frontend/layouts/Handheld";
import type { FormSubmitEvent } from "./index";

export function SignUp(props: {
  /** False on first run: with no account yet, there is nowhere to go back to. */
  canCancel: boolean;
  busy: boolean;
  error: string | undefined;
  password: string;
  onPasswordInput(value: string): void;
  onSubmit(event: FormSubmitEvent): void;
  onCancel(): void;
}) {
  // Creating is the only thing to do here, so it is the one primary action.
  // Once an account exists there is somewhere to go back to, and that is all
  // the second button is for.
  const actions = (): Action[] => [
    ...(props.canCancel
      ? [{
        side: "start" as const,
        icon: "👈",
        label: "Back",
        disabled: props.busy,
        onClick: props.onCancel,
      }]
      : []),
    {
      side: "end",
      icon: "👌",
      label: "Create account",
      variant: "primary",
      type: "submit",
      busy: props.busy,
      disabled: props.busy,
    },
  ];

  return (
    <Handheld icon="👋" title="Sign Up" actions={actions()} onSubmit={props.onSubmit}>
      <Show when={props.error}>{(message) => <p role="alert">{message()}</p>}</Show>
      <Card>
        <TextField
          id="username"
          name="username"
          label="Username"
          autocomplete="username"
          pattern="[a-z]{1,64}"
          title="Use 1 to 64 lowercase English letters."
          required
        />
        <TextField
          id="new-password"
          name="new-password"
          label="Password"
          type="password"
          autocomplete="new-password"
          required
          value={props.password}
          onInput={props.onPasswordInput}
        />
        <PasswordStrength password={props.password} />
        <TextField
          id="password-confirmation"
          name="password-confirmation"
          label="Confirm password"
          type="password"
          autocomplete="new-password"
          required
        />
      </Card>
    </Handheld>
  );
}
