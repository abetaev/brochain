import { For, Show } from "solid-js";
import type { Action } from "@v/frontend/components/ActionBar";
import { Avatar } from "@v/frontend/components/Avatar";
import { Button } from "@v/frontend/components/Button";
import { List } from "@v/frontend/components/List";
import { ListItem } from "@v/frontend/components/ListItem";
import { Handheld } from "@v/frontend/layouts/Handheld";

export function Select(props: {
  accounts: readonly string[];
  busy: boolean;
  error: string | undefined;
  onSignIn(username: string): void;
  onExport(username: string): void;
  onDelete(username: string): void;
  onCreate(): void;
}) {
  const actions = (): Action[] => [{
    side: "end",
    icon: "🫵",
    label: "Create another account",
    disabled: props.busy,
    onClick: props.onCreate,
  }];

  return (
    <Handheld icon="✊" title="Choose Account" actions={actions()}>
      <Show when={props.error}>{(message) => <p role="alert">{message()}</p>}</Show>
      <List>
        <For each={props.accounts}>
          {(username) => (
            <ListItem
              avatar={<Avatar seed={username} name={username} />}
              label={username}
              onClick={() => props.onSignIn(username)}
              actions={
                <>
                  <Button
                    icon="🪪"
                    label="Export"
                    size="sm"
                    disabled={props.busy}
                    onClick={() => props.onExport(username)}
                  />
                  <Button
                    icon="☠️"
                    label="Delete account"
                    variant="rejection"
                    size="sm"
                    disabled={props.busy}
                    onClick={() => props.onDelete(username)}
                  />
                </>
              }
            />
          )}
        </For>
      </List>
    </Handheld>
  );
}
