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

  await signOut(bob);
  await expect(peerNamed(alice, "bob").getByLabel("Connected", { exact: true })).toBeHidden();
  await expect(peerNamed(alice, "bob")).toContainText("bob");

  // Identity was persisted while connected, so it names the peer before any dial.
  await unlock(bob, "bob");
  await expect(peerNamed(bob, "alice")).toBeVisible();
  await expect(peerNamed(bob, "alice").getByLabel("Connected", { exact: true })).toBeHidden();
});
