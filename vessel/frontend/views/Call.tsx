import { Show, createEffect, createSignal, onCleanup } from "solid-js";
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

  return (
    <section aria-labelledby="call-heading">
      <header>
        <button class="secondary" type="button" onClick={leave}>Back</button>
        <h2 id="call-heading">Call with {name()}</h2>
      </header>

      <Show when={call()} fallback={<p>This call is over.</p>}>
        {(current) => (
          <>
            <p>{statusMessage(current(), name())}</p>
            <Show when={current().error}>
              {(message) => <p role="alert">{message()}</p>}
            </Show>

            <Stream stream={current().remote} label="Remote video" />
            <Stream stream={current().local} label="Your video" muted />

            <Show when={current().status !== "ended"}>
              <Show
                when={current().direction === "incoming" && current().status === "pending"}
                fallback={
                  <>
                    <button
                      type="button"
                      class="secondary"
                      onClick={() => props.call.setMicrophone(!current().microphone)}
                    >
                      {current().microphone ? "Mute microphone" : "Unmute microphone"}
                    </button>{" "}
                    <button
                      type="button"
                      class="secondary"
                      onClick={() => props.call.setCamera(!current().camera)}
                    >
                      {current().camera ? "Stop camera" : "Start camera"}
                    </button>{" "}
                    <button
                      type="button"
                      onClick={() => {
                        props.call.end();
                        props.onBack();
                      }}
                    >
                      Hang up
                    </button>
                  </>
                }
              >
                <button type="button" onClick={() => void props.call.accept()}>Accept</button>
                {" "}
                <button
                  type="button"
                  class="secondary"
                  onClick={() => {
                    props.call.decline();
                    props.onBack();
                  }}
                >
                  Decline
                </button>
              </Show>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}

// The element is recreated whenever this view is opened, so the stream is
// attached from an effect and a reader returning mid-call sees the picture again.
function Stream(props: { stream?: MediaStream; label: string; muted?: boolean }) {
  let element: HTMLVideoElement | undefined;

  createEffect(() => {
    if (element !== undefined) element.srcObject = props.stream ?? null;
  });

  return (
    <video
      ref={element}
      aria-label={props.label}
      autoplay
      playsinline
      muted={props.muted === true}
    />
  );
}

function statusMessage(call: CallState, name: string): string {
  if (call.status === "active") return `In a call with ${name}.`;
  if (call.status === "connecting") return "Establishing a media path…";
  if (call.status === "ended") return "The call ended.";
  return call.direction === "outgoing" ? `Calling ${name}…` : `${name} is calling.`;
}
