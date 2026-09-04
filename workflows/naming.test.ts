import { connectToPeer, expect, peerNamed, test } from "./vessel.ts";

test("a peer arrives named by its identity and can be renamed locally", async ({
  openVessel,
}) => {
  const alice = await openVessel("alice");
  const bob = await openVessel("bob");

  await connectToPeer(alice, "bob");
  await alice.getByRole("button", { name: "Back to Home" }).click();
  await peerNamed(alice, "bob").getByRole("button", { name: "bob settings", exact: true }).click();
  await alice.getByRole("button", { name: "Edit" }).click();
  await expect(alice.getByLabel("Name for this peer")).toHaveValue("bob");

  await alice.getByLabel("Name for this peer").fill("  the other one  ");
  await alice.getByRole("button", { name: "Save name" }).click();

  // The chosen name reaches every reference to that peer, trimmed as stored.
  await expect(alice.getByRole("heading", { name: "Peer the other one" })).toBeVisible();
  await alice.getByRole("button", { name: "Back" }).click();
  await expect(peerNamed(alice, "the other one")).toBeVisible();
  await peerNamed(alice, "the other one").getByRole("button", { name: "the other one", exact: true })
    .click();
  await expect(alice.getByRole("heading", { name: "Chat with the other one" })).toBeVisible();

  // Bob is unaffected: the name is alice's alone.
  await expect(peerNamed(bob, "alice")).toBeVisible();

  await alice.getByRole("button", { name: "the other one settings", exact: true }).click();
  await alice.getByRole("button", { name: "Reset name" }).click();
  await expect(alice.getByRole("heading", { name: "Peer bob" })).toBeVisible();
  await alice.getByRole("button", { name: "Edit" }).click();
  await expect(alice.getByLabel("Name for this peer")).toHaveValue("bob");
  await alice.getByRole("button", { name: "Back" }).click();
  await expect(alice.getByRole("heading", { name: "Chat with bob" })).toBeVisible();

  // While bob still reports a name, alice can only ask him again for it.
  await alice.getByRole("button", { name: "bob settings", exact: true }).click();
  await expect(alice.getByRole("button", { name: "Refresh identity" })).toBeVisible();

  // Once he withholds it, the same control offers to forget what he last reported,
  // and only then does resetting leave alice with his peer ID.
  await peerNamed(bob, "alice").getByRole("button", { name: "alice settings", exact: true }).click();
  await bob.getByRole("switch", { name: "identity" }).uncheck();

  await alice.getByRole("button", { name: "Clear identity" }).click();
  await alice.getByRole("button", { name: "Reset name" }).click();
  await expect(alice.getByRole("heading", { name: "Peer bob" })).toBeHidden();
  await alice.getByRole("button", { name: "Edit" }).click();
  await expect(alice.getByLabel("Name for this peer")).toHaveValue("");
  await alice.getByRole("button", { name: "Back" }).click();
  await expect(peerNamed(alice, "bob")).toHaveCount(0);
});
