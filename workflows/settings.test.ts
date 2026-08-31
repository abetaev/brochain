import { connectToPeer, expect, peerNamed, peerOffering, test } from "./vessel.ts";

test("refusing a service withholds it from that peer at once", async ({ openVessel }) => {
  const alice = await openVessel("alice");
  const bob = await openVessel("bob");

  await connectToPeer(alice, "bob");
  await peerOffering(bob, "Chat").getByRole("button", { name: "Chat" }).click();
  await expect(bob.getByRole("heading", { name: "Chat with alice" })).toBeVisible();
  await expect(bob.getByLabel("Message")).toBeEnabled();

  await alice.getByRole("button", { name: "Back to Home" }).click();
  await peerNamed(alice, "bob").getByRole("button", { name: "Settings" }).click();
  await expect(alice.getByRole("heading", { name: "Peer bob" })).toBeVisible();
  await expect(alice.getByRole("switch", { name: "messaging" })).toBeChecked();

  await alice.getByRole("switch", { name: "messaging" }).uncheck();

  // Alice stops publishing messaging, and the announced catalog reaches bob
  // without him asking again.
  await expect(bob.getByLabel("Message")).toBeDisabled();
  await bob.getByRole("button", { name: "Back to Home" }).click();
  await expect(peerNamed(bob, "alice").getByRole("button", { name: "Chat" })).toBeHidden();

  await alice.getByRole("switch", { name: "messaging" }).check();
  await expect(bob.getByRole("button", { name: "Settings" }).first()).toBeVisible();
  await expect(peerNamed(bob, "alice").getByRole("button", { name: "Chat" })).toBeVisible();
});
