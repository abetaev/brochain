import { connectToPeer, expect, peerNamed, test } from "./vessel.ts";

test("refusing a service withholds it from that peer at once", async ({ openVessel }) => {
  const alice = await openVessel("alice");
  const bob = await openVessel("bob");

  await connectToPeer(alice, "bob");
  await peerNamed(bob, "alice").getByRole("button", { name: "alice", exact: true }).click();
  await expect(bob.getByRole("heading", { name: "Chat with alice" })).toBeVisible();
  await expect(bob.getByLabel("Message", { exact: true })).toBeEnabled();

  await alice.getByRole("button", { name: "Back to Home" }).click();
  await peerNamed(alice, "bob").getByRole("button", { name: "bob settings", exact: true }).click();
  await expect(alice.getByRole("heading", { name: "Peer bob" })).toBeVisible();
  await expect(alice.getByRole("switch", { name: "messaging" })).toBeChecked();

  await alice.getByRole("switch", { name: "messaging" }).uncheck();

  // Alice stops publishing messaging, and the announced catalog reaches bob
  // without him asking again — his still-open chat with her reflects it live.
  await expect(bob.getByLabel("Message", { exact: true })).toBeDisabled();

  await alice.getByRole("switch", { name: "messaging" }).check();
  await expect(bob.getByLabel("Message", { exact: true })).toBeEnabled();
});
