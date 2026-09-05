import "./Button.css";

export function Button(props: {
  icon: string;
  /** The accessible name — icon-only buttons have no visible text to fall back on. */
  label: string;
  variant?: "primary" | "secondary" | "confirmation" | "rejection";
  size?: "md" | "compact" | "sm";
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  busy?: boolean;
  onClick?: () => void;
}) {
  const variant = () => props.variant ?? "secondary";

  return (
    <button
      type={props.type ?? "button"}
      class="button"
      classList={{
        primary: variant() === "primary",
        secondary: variant() === "secondary",
        confirmation: variant() === "confirmation",
        rejection: variant() === "rejection",
        compact: props.size === "compact",
        sm: props.size === "sm",
      }}
      aria-label={props.label}
      aria-busy={props.busy === true}
      disabled={props.disabled === true}
      onClick={props.onClick}
    >
      <span aria-hidden="true">{props.icon}</span>
    </button>
  );
}
