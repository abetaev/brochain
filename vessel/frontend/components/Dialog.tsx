import { onCleanup, onMount, createEffect, type JSX } from "solid-js";
import { Button } from "@v/frontend/components/Button";
import "./Dialog.css";

// A question asked over the view: a title, the fields the caller supplies, and the
// two answers the design ends every dialog with. The browser owns the modality,
// so what is behind it is inert and Escape answers 👎 like the button does.
export function Dialog(props: {
  open: boolean;
  title: string;
  /** The accessible name of the confirming answer, which is drawn as 👍. */
  confirmLabel: string;
  disabled?: boolean;
  onCancel(): void;
  onConfirm(form: HTMLFormElement): void;
  children: JSX.Element;
}) {
  let element!: HTMLDialogElement;

  createEffect(() => {
    if (props.open) {
      if (!element.open) element.showModal();
    } else if (element.open) {
      element.close();
    }
  });

  // Escape closes the dialog itself, so the reader's answer is read from the
  // element rather than from a key.
  onMount(() => {
    const closed = () => props.onCancel();
    element.addEventListener("close", closed);
    onCleanup(() => element.removeEventListener("close", closed));
  });

  return (
    <dialog class="dialog" ref={element} aria-label={props.title}>
      <h2>{props.title}</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          props.onConfirm(event.currentTarget);
        }}
      >
        {props.children}
        <div class="dialog-actions">
          <Button icon="👎" label="Cancel" variant="rejection" onClick={props.onCancel} />
          <Button
            icon="👍"
            label={props.confirmLabel}
            variant="confirmation"
            type="submit"
            disabled={props.disabled}
          />
        </div>
      </form>
    </dialog>
  );
}
