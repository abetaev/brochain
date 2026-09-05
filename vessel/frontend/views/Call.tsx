import { Show, createSignal, onCleanup } from "solid-js";
import {
  displayName,
  observeDisplayName,
} from "@v/backend/options/peer-names";
import type { Session } from "@v/backend/session";
import type { Action } from "@v/frontend/components/ActionBar";
import { Conference } from "@v/frontend/components/Conference";
import type { Notification } from "@v/frontend/services/notifications";
import { Handheld } from "@v/frontend/layouts/Handheld";
import "./Call.css";
import type { Call as CallService, CallState } from "@v/frontend/services/call";
import type { Roster } from "@v/frontend/services/roster";

type ControlAction = Omit<Extract<Action, { icon: string }>, "side" | "group">;

export function Call(props: {
  session: Session;
  call: CallService;
  roster: Roster;
  peerId: string;
  notifications: readonly Notification[];
  onBack(): void;
}) {
  const [state, setState] = createSignal<CallState | undefined>(props.call.current());
  const [entry, setEntry] = createSignal(props.roster.get(props.peerId));
  const localId = props.session.network().id;
  const [chosenName, setChosenName] = createSignal(
    displayName(props.session.options(), localId),
  );
  const localName = () => chosenName() ?? props.session.username;
  const stops = [
    props.call.updates.subscribe((next) => setState(next)),
    observeDisplayName(props.session.options(), localId, setChosenName),
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

  // The view is only ever open while the call runs, so leaving it simply leaves;
  // ending the call takes the reader back on its own.
  function hangUp(): void {
    props.call.end();
  }

  // Consecutive actions sharing a group merge into one control, which is how the
  // mockup draws the call controls at the end of the bar.
  const control = (action: ControlAction): Action => ({ side: "end", group: "call", ...action });

  const controls = (): Action[] => {
    const current = call();
    if (current === undefined) return [];
    return [
      control({
        icon: "🎤",
        label: current.microphone ? "Mute microphone" : "Unmute microphone",
        onClick: () => props.call.setMicrophone(!current.microphone),
      }),
      control({
        icon: "📷",
        label: current.camera ? "Stop camera" : "Start camera",
        onClick: () => props.call.setCamera(!current.camera),
      }),
      control({ icon: "🖕", label: "Hang up", variant: "rejection", onClick: hangUp }),
    ];
  };

  const actions = (): Action[] => [
    { side: "start", icon: "👈", label: "Back", onClick: props.onBack },
    ...controls(),
  ];

  return (
    <Handheld
      avatar={{ seed: localId, name: localName() }}
      title={localName()}
      heading={`Call with ${name()}`}
      notifications={props.notifications}
      actions={actions()}
      bleed
    >
      <Show when={call()}>
        {(current) => (
          <section class="call-stage">
            <Conference remote={current().remote} local={current().local} />
            {/* Captioned over the remote tile, where the mockup labels it. */}
            <div class="call-captions">
              <p>{statusMessage(current(), name())}</p>
            </div>
          </section>
        )}
      </Show>
    </Handheld>
  );
}

function statusMessage(call: CallState, name: string): string {
  return call.status === "active"
    ? `In a call with ${name}.`
    : "Establishing a media path…";
}
