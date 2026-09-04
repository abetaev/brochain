import { Show, type JSX } from "solid-js";
import "./ListItem.css";

// The whole row is the primary target. An avatar passed with its own onClick
// keeps its own action; a plain one lets the click fall through to the row.
export function ListItem(props: {
  avatar?: JSX.Element;
  label: string;
  onClick?: () => void;
  actions?: JSX.Element;
}) {
  return (
    <li class="listitem">
      {props.avatar}
      <Show when={props.onClick} fallback={<span class="listitem-label">{props.label}</span>}>
        {(onClick) => (
          <button type="button" class="listitem-label listitem-surface" onClick={onClick()}>
            {props.label}
          </button>
        )}
      </Show>
      <Show when={props.actions}>
        {(actions) => <span class="listitem-actions">{actions()}</span>}
      </Show>
    </li>
  );
}
