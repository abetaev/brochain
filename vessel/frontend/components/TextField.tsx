import "./TextField.css";

// Passing `value` without `onInput` still works: Solid only re-applies the
// property when the expression it's bound to changes, so a plain string seeds
// the field and it behaves as an ordinary uncontrolled input, read via FormData.
export function TextField(props: {
  id: string;
  name: string;
  label: string;
  type?: string;
  value?: string;
  onInput?: (value: string) => void;
  required?: boolean;
  autocomplete?: string;
  disabled?: boolean;
  maxlength?: number;
  pattern?: string;
  title?: string;
}) {
  return (
    <div class="textfield">
      <input
        id={props.id}
        name={props.name}
        type={props.type ?? "text"}
        placeholder=" "
        value={props.value ?? ""}
        required={props.required}
        autocomplete={props.autocomplete as never}
        disabled={props.disabled}
        maxlength={props.maxlength}
        pattern={props.pattern}
        title={props.title}
        onInput={(event) => props.onInput?.(event.currentTarget.value)}
      />
      <label for={props.id}>{props.label}</label>
    </div>
  );
}
