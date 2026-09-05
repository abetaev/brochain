import { Show, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { ActionBar, type Action } from "@v/frontend/components/ActionBar";
import { StatusBar, type Designation } from "@v/frontend/components/StatusBar";
import type { Notification } from "@v/frontend/services/notifications";
import "./Handheld.css";

// The vertical phone layout: a StatusBar naming the view, bottom-aligned content,
// and an ActionBar generated from the view's actions. A view supplies what goes in
// each region and never lays the regions out itself.
export function Handheld(props: {
  icon?: string;
  avatar?: Designation;
  title: string;
  heading?: string;
  notifications?: readonly Notification[];
  actions?: readonly Action[];
  /** Pinned between the scrolling content and the ActionBar, e.g. Chat's compose bar. */
  footer?: JSX.Element;
  /** Content fills the region edge to edge instead of sitting in padding, e.g. Call's conference. */
  bleed?: boolean;
  // When given, the content and the ActionBar share one form, so an action in the
  // bar can submit a field in the content — or in the bar itself, as Sign In does.
  onSubmit?: (event: SubmitEvent & { currentTarget: HTMLFormElement }) => void;
  children: JSX.Element;
}) {
  return (
    <div class="handheld">
      <StatusBar
        icon={props.icon}
        avatar={props.avatar}
        title={props.title}
        heading={props.heading}
        notifications={props.notifications}
      />
      <Dynamic
        component={props.onSubmit === undefined ? "div" : "form"}
        class="handheld-body"
        onSubmit={props.onSubmit}
      >
        <main class="handheld-content" classList={{ bleed: props.bleed === true }}>
          {props.children}
        </main>
        {props.footer}
        <Show when={props.actions}>{(actions) => <ActionBar actions={actions()} />}</Show>
      </Dynamic>
    </div>
  );
}
