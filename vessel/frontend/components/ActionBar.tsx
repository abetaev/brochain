import { For, Show, type JSX } from "solid-js";
import { Button } from "@v/frontend/components/Button";
import "./ActionBar.css";

interface Placement {
  /** Which end of the bar the action belongs to. Defaults to "start". */
  readonly side?: "start" | "end";
  /** Adjacent actions sharing a group render as one merged control. */
  readonly group?: string;
}

export type Action =
  & Placement
  & (
    | {
      readonly icon: string;
      readonly label: string;
      readonly variant?: "primary" | "secondary" | "confirmation" | "rejection";
      readonly type?: "button" | "submit" | "reset";
      readonly disabled?: boolean;
      readonly busy?: boolean;
      readonly onClick?: () => void;
    }
    // For the occasional action that isn't a button — Sign In's password field.
    | { readonly element: JSX.Element }
  );

// Placement, grouping and rounding live here alone, so no view repeats them.
export function ActionBar(props: { actions: readonly Action[] }) {
  const sided = (side: "start" | "end") =>
    props.actions.filter((action) => (action.side ?? "start") === side);

  return (
    <footer class="actionbar">
      <ActionRuns actions={sided("start")} />
      <span class="actionbar-end">
        <ActionRuns actions={sided("end")} />
      </span>
    </footer>
  );
}

function ActionRuns(props: { actions: readonly Action[] }) {
  return (
    <For each={runs(props.actions)}>
      {(run) => (
        <Show when={run.length > 1} fallback={<ActionItem action={run[0]!} />}>
          <div class="action-group">
            <For each={run}>{(action) => <ActionItem action={action} />}</For>
          </div>
        </Show>
      )}
    </For>
  );
}

function ActionItem(props: { action: Action }) {
  return (
    <Show when={"element" in props.action ? props.action : undefined} fallback={<ActionButton action={props.action} />}>
      {(custom) => custom().element}
    </Show>
  );
}

function ActionButton(props: { action: Action }) {
  const action = () => props.action as Extract<Action, { icon: string }>;
  return (
    <Button
      icon={action().icon}
      label={action().label}
      variant={action().variant}
      type={action().type}
      disabled={action().disabled}
      busy={action().busy}
      onClick={action().onClick}
    />
  );
}

// Consecutive actions that name the same group become one run; everything else
// stands alone.
function runs(actions: readonly Action[]): Action[][] {
  const grouped: Action[][] = [];
  for (const action of actions) {
    const previous = grouped[grouped.length - 1];
    const continues = previous !== undefined &&
      action.group !== undefined &&
      action.group === previous[0]?.group;
    if (continues) previous.push(action);
    else grouped.push([action]);
  }
  return grouped;
}
