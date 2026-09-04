import { Show, createSignal } from "solid-js";
import { Button } from "@v/frontend/components/Button";
import "./EditableLabel.css";

export function EditableLabel(props: {
  value: string;
  placeholder?: string;
  inputLabel?: string;
  onSave: (next: string) => Promise<void> | void;
  saveLabel?: string;
  editLabel?: string;
  cancelLabel?: string;
}) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal(props.value);

  function startEditing(): void {
    setDraft(props.value);
    setEditing(true);
  }

  async function confirm(): Promise<void> {
    await props.onSave(draft());
    setEditing(false);
  }

  return (
    <div class="editable-label">
      <Show
        when={editing()}
        fallback={
          <>
            <span class="value">{props.value.length > 0 ? props.value : props.placeholder}</span>
            <Button icon="✏️" label={props.editLabel ?? "Edit"} variant="secondary" size="sm" onClick={startEditing} />
          </>
        }
      >
        <label>
          <span class="sr-only">{props.inputLabel ?? "Name"}</span>
          <input
            value={draft()}
            size={Math.max(draft().length, 3)}
            onInput={(event) => setDraft(event.currentTarget.value)}
          />
        </label>
        <Button
          icon="👍"
          label={props.saveLabel ?? "Save name"}
          variant="confirmation"
          size="sm"
          onClick={() => void confirm()}
        />
        <Button
          icon="👎"
          label={props.cancelLabel ?? "Cancel"}
          variant="secondary"
          size="sm"
          onClick={() => setEditing(false)}
        />
      </Show>
    </div>
  );
}
