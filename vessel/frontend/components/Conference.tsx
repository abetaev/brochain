import { createEffect } from "solid-js";

// The element is recreated whenever the call view is opened, so the stream is
// attached from an effect and a reader returning mid-call sees the picture again.
function VideoTile(props: { stream?: MediaStream; label: string; class: string; muted?: boolean }) {
  let element: HTMLVideoElement | undefined;

  createEffect(() => {
    if (element !== undefined) element.srcObject = props.stream ?? null;
  });

  return (
    <video
      ref={element}
      class={props.class}
      aria-label={props.label}
      autoplay
      playsinline
      muted={props.muted === true}
    />
  );
}

export function Conference(props: { remote?: MediaStream; local?: MediaStream }) {
  return (
    <div class="conference">
      <VideoTile stream={props.remote} label="Remote video" class="remote" />
      <VideoTile stream={props.local} label="Your video" class="local" muted />
    </div>
  );
}
