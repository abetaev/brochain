import {
  acceptEveryone,
  connectToPeer,
  expect,
  peerNamed,
  signOut,
  test,
  unlock,
} from "./vessel.ts";

test("a returning person is remembered by name while the other stays online", async ({
  openVessel,
}) => {
  const alice = await openVessel("alice");
  const bob = await openVessel("bob");
  await acceptEveryone(alice);
  await acceptEveryone(bob);

  await connectToPeer(bob);
  await bob.getByRole("button", { name: "Back to Home" }).click();
  await expect(peerNamed(bob, "alice").getByLabel("Connected", { exact: true })).toBeVisible();
  await expect(peerNamed(alice, "bob").getByLabel("Connected", { exact: true })).toBeVisible();

  // The Beacon stops advertising a peer which left, so alice holds no address for
  // bob any more and his row says he cannot be reached at all.
  await signOut(bob);
  await expect(peerNamed(alice, "bob").getByLabel("Unavailable", { exact: true })).toBeVisible();
  await expect(peerNamed(alice, "bob")).toContainText("bob");

  // Identity was persisted while connected, so it names the peer before any dial.
  await unlock(bob, "bob");
  await expect(peerNamed(bob, "alice")).toBeVisible();
  await expect(peerNamed(bob, "alice").getByLabel("Disconnected", { exact: true }))
    .toBeVisible();
});

test("a person drops a connection from the conversation and reaches it again", async ({
  openVessel,
}) => {
  const alice = await openVessel("alice");
  const bob = await openVessel("bob");
  await acceptEveryone(alice);
  await acceptEveryone(bob);

  await connectToPeer(alice);
  await expect(alice.getByLabel("Message", { exact: true })).toBeEnabled();

  // Leaving a conversation drops the connection for both, and the roster says so.
  await alice.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(alice.getByLabel("Message", { exact: true })).toBeDisabled();
  await expect(peerNamed(bob, "alice").getByLabel("Disconnected", { exact: true }))
    .toBeVisible();

  // The addresses the Beacon advertises are still known, so the conversation reaches
  // that peer again on its own.
  await alice.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(alice.getByLabel("Message", { exact: true })).toBeEnabled();
  await expect(peerNamed(bob, "alice").getByLabel("Connected", { exact: true })).toBeVisible();
});
