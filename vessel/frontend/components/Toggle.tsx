import "./Toggle.css";

export function Toggle(props: {
  id: string;
  label: string;
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div class="toggle-row">
      <label for={props.id}>
        <input
          id={props.id}
          type="checkbox"
          role="switch"
          checked={props.checked}
          disabled={props.disabled}
          onChange={(event) => props.onChange?.(event.currentTarget.checked)}
        />
        {props.label}
      </label>
      {props.hint !== undefined ? <small>{props.hint}</small> : null}
    </div>
  );
}
