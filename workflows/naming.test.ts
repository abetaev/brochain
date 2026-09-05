import { acceptEveryone, connectToPeer, expect, peerNamed, test } from "./vessel.ts";

test("a peer arrives named by its identity and can be renamed locally", async ({
  openVessel,
}) => {
  const alice = await openVessel("alice");
  const bob = await openVessel("bob");
  await acceptEveryone(alice);
  await acceptEveryone(bob);

  await connectToPeer(alice);
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

test("a person names themselves, and decides how connections reach them", async ({
  openVessel,
}) => {
  const alice = await openVessel("alice");

  // This peer's own avatar is the way to this peer's own settings.
  await alice.getByRole("button", { name: "Settings", exact: true }).click();
  const heading = alice.getByRole("heading", { name: "Settings" });
  await expect(heading).toBeVisible();
  await expect(heading).toHaveText("alice");

  // The address someone else needs to reach us is here, and nowhere else.
  await expect(alice.getByText("Peer ID")).toBeVisible();

  await alice.getByRole("button", { name: "Edit" }).click();
  await expect(alice.getByLabel("Name for this peer")).toHaveValue("");
  await alice.getByLabel("Name for this peer").fill("alice of the north");
  await alice.getByRole("button", { name: "Save name" }).click();
  await expect(heading).toHaveText("alice of the north");

  // Resetting returns us to the account username, which named us to begin with.
  await alice.getByRole("button", { name: "Reset name" }).click();
  await expect(heading).toHaveText("alice");
  await expect(alice.getByRole("button", { name: "Reset name" })).toBeHidden();

  // Our own services are the connection profile, deciding what a peer nobody has
  // decided about reaches. Registry alone is granted until something else is, and
  // the decision is remembered.
  await expect(alice.getByRole("switch", { name: "registry", exact: true })).toBeChecked();
  const messaging = alice.getByRole("switch", { name: "messaging", exact: true });
  await expect(messaging).not.toBeChecked();
  await messaging.check();

  await alice.getByRole("button", { name: "Back" }).click();
  await expect(alice.getByRole("heading", { name: "Home" })).toBeVisible();
  await alice.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(alice.getByRole("switch", { name: "messaging", exact: true })).toBeChecked();
});
