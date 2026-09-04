import { Show, createSignal, onCleanup } from "solid-js";
import { AppBar } from "@v/frontend/components/AppBar";
import { Avatar } from "@v/frontend/components/Avatar";
import { Button } from "@v/frontend/components/Button";
import { ButtonGroup } from "@v/frontend/components/ButtonGroup";
import { Conference } from "@v/frontend/components/Conference";
import type { Call as CallService, CallState } from "@v/frontend/services/call";
import type { Roster } from "@v/frontend/services/roster";

export function Call(props: {
  call: CallService;
  roster: Roster;
  peerId: string;
  onBack(): void;
}) {
  const [state, setState] = createSignal<CallState | undefined>(props.call.current());
  const [entry, setEntry] = createSignal(props.roster.get(props.peerId));
  const stops = [
    props.call.updates.subscribe((next) => setState(next)),
    props.roster.updates.subscribe((update) => {
      if (update.type === "set") {
        if (update.entry.peerId === props.peerId) setEntry(update.entry);
      } else if (update.peerId === props.peerId) {
        setEntry(undefined);
      }
    }),
  ];
  onCleanup(() => stops.forEach((stop) => stop()));

  const name = () => entry()?.name ?? props.peerId;
  const call = () => {
    const current = state();
    return current?.peerId === props.peerId ? current : undefined;
  };

  // Leaving a running call keeps it; leaving a finished one acknowledges it.
  function leave(): void {
    if (call()?.status === "ended") props.call.dismiss();
    props.onBack();
  }

  function hangUp(): void {
    props.call.end();
    props.onBack();
  }

  return (
    <div class="view">
      <AppBar position="top">
        <Avatar seed={props.peerId} name={name()} />
        <h2 id="call-heading">Call with {name()}</h2>
      </AppBar>
      <main class="view-content">
        <Show when={call()} fallback={<p>This call is over.</p>}>
          {(current) => (
            <>
              <p>{statusMessage(current(), name())}</p>
              <Show when={current().error}>
                {(message) => <p role="alert">{message()}</p>}
              </Show>
              <Conference remote={current().remote} local={current().local} />
            </>
          )}
        </Show>
      </main>
      <AppBar position="bottom">
        <Button icon="👈" label="Back" variant="secondary" onClick={leave} />
        <span class="appbar-end">
          <Show when={call()}>
            {(current) => (
              <Show when={current().status !== "ended"}>
                <Show
                  when={current().direction === "incoming" && current().status === "pending"}
                  fallback={
                    <Show
                      when={current().direction === "outgoing" && current().status === "pending"}
                      fallback={
                        <ButtonGroup>
                          <Button
                            icon="🎤"
                            label={current().microphone ? "Mute microphone" : "Unmute microphone"}
                            variant="secondary"
                            onClick={() => props.call.setMicrophone(!current().microphone)}
                          />
                          <Button
                            icon="📷"
                            label={current().camera ? "Stop camera" : "Start camera"}
                            variant="secondary"
                            onClick={() => props.call.setCamera(!current().camera)}
                          />
                          <Button icon="🖕" label="Hang up" variant="rejection" onClick={hangUp} />
                        </ButtonGroup>
                      }
                    >
                      <ButtonGroup>
                        <Button icon="🤙" label="Ringing…" variant="secondary" disabled />
                        <Button icon="🖕" label="Cancel call" variant="rejection" onClick={hangUp} />
                      </ButtonGroup>
                    </Show>
                  }
                >
                  <ButtonGroup>
                    <Button icon="👍" label="Accept" variant="confirmation" onClick={() => void props.call.accept()} />
                    <Button
                      icon="🖕"
                      label="Decline"
                      variant="rejection"
                      onClick={() => {
                        props.call.decline();
                        props.onBack();
                      }}
                    />
                  </ButtonGroup>
                </Show>
              </Show>
            )}
          </Show>
        </span>
      </AppBar>
    </div>
  );
}

function statusMessage(call: CallState, name: string): string {
  if (call.status === "active") return `In a call with ${name}.`;
  if (call.status === "connecting") return "Establishing a media path…";
  if (call.status === "ended") return "The call ended.";
  return call.direction === "outgoing" ? `Calling ${name}…` : `${name} is calling.`;
}
