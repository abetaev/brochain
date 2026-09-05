import type { Page } from "@playwright/test";
import { acceptEveryone, connectToPeer, expect, peerNamed, test } from "./vessel.ts";

function peerSettings(page: Page, name: string) {
  return peerNamed(page, name).getByRole("button", { name: `${name} settings`, exact: true });
}

test("a peer reaches nothing until it is let in", async ({ openVessel }) => {
  const alice = await openVessel("alice");
  const bob = await openVessel("bob");
  await acceptEveryone(alice);

  // Alice lets in everyone she has decided nothing about, so bob knows her name.
  // Bob has decided nothing and grants nothing, so she cannot write to him.
  await connectToPeer(alice);
  await expect(alice.getByLabel("Message", { exact: true })).toBeDisabled();

  await peerSettings(bob, "alice").click();
  await expect(bob.getByText("Requesting a connection")).toBeVisible();
  await bob.getByRole("switch", { name: "messaging", exact: true }).check();

  // Letting her in publishes at once, and the conversation she already has revives.
  await expect(bob.getByText("Connected", { exact: true })).toBeVisible();
  await expect(alice.getByLabel("Message", { exact: true })).toBeEnabled();

  // The row says the decision is bob's own, and hands it back to the profile.
  await bob.getByRole("button", { name: "Use default" }).click();
  await expect(alice.getByLabel("Message", { exact: true })).toBeDisabled();
});

test("the profile answers for a peer nobody has decided about", async ({ openVessel }) => {
  const alice = await openVessel("alice");
  await acceptEveryone(alice);
  const bob = await openVessel("bob");
  await acceptEveryone(bob);

  // Neither has said anything about the other, and both can talk at once.
  await connectToPeer(bob);
  await expect(bob.getByLabel("Message", { exact: true })).toBeEnabled();

  await peerSettings(alice, "bob").click();
  await expect(alice.getByRole("switch", { name: "messaging", exact: true })).toBeChecked();
  await expect(alice.getByText("Default").first()).toBeVisible();
  await expect(alice.getByRole("button", { name: "Use default" })).toHaveCount(0);
});

test("withholding the registry closes that peer's connection", async ({ openVessel }) => {
  const alice = await openVessel("alice");
  const bob = await openVessel("bob");
  await acceptEveryone(alice);
  await acceptEveryone(bob);

  await connectToPeer(alice);
  await expect(alice.getByLabel("Message", { exact: true })).toBeEnabled();

  await peerSettings(bob, "alice").click();
  await bob.getByRole("switch", { name: "registry", exact: true }).uncheck();

  // A peer left no way to learn what it may reach is barred, so its connection goes.
  await expect(bob.getByText("Not connected")).toBeVisible();
  await expect(alice.getByRole("alert")).toContainText("not connected");

  await alice.getByRole("button", { name: "Back to Home" }).click();
  await expect(peerNamed(alice, "bob").getByLabel("Disconnected", { exact: true }))
    .toBeVisible();
});

test("refusing a service withholds it from that peer at once", async ({ openVessel }) => {
  const alice = await openVessel("alice");
  const bob = await openVessel("bob");
  await acceptEveryone(alice);
  await acceptEveryone(bob);

  await connectToPeer(alice);
  await peerNamed(bob, "alice").getByRole("button", { name: "alice", exact: true }).click();
  await expect(bob.getByRole("heading", { name: "Chat with alice" })).toBeVisible();
  await expect(bob.getByLabel("Message", { exact: true })).toBeEnabled();

  await alice.getByRole("button", { name: "Back to Home" }).click();
  await peerSettings(alice, "bob").click();
  await expect(alice.getByRole("heading", { name: "Peer bob" })).toBeVisible();
  await expect(alice.getByRole("switch", { name: "messaging", exact: true })).toBeChecked();

  await alice.getByRole("switch", { name: "messaging", exact: true }).uncheck();

  // Alice stops publishing messaging, and the announced catalog reaches bob
  // without him asking again — his still-open chat with her reflects it live.
  await expect(bob.getByLabel("Message", { exact: true })).toBeDisabled();

  await alice.getByRole("switch", { name: "messaging", exact: true }).check();
  await expect(bob.getByLabel("Message", { exact: true })).toBeEnabled();
});
