import {
  acceptEveryone,
  connectToPeer,
  expect,
  peerNamed,
  peerSettings,
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

test("the first peer an account meets arrives marked for connection", async ({
  openVessel,
}) => {
  const alice = await openVessel("alice");

  // The Beacon this page connects to is the first peer alice ever meets, and it
  // offers no name, so it is listed by its peer ID and reached through its avatar.
  const beacon = alice.getByRole("listitem")
    .filter({ has: alice.getByLabel("Connected", { exact: true }) });
  await beacon.getByRole("button", { name: /settings$/ }).click();
  await expect(alice.getByRole("switch", { name: "Connect automatically" })).toBeChecked();
});

test("a marked peer is reached again as soon as it returns", async ({ openVessel }) => {
  const alice = await openVessel("alice");
  const bob = await openVessel("bob");
  await acceptEveryone(alice);
  await acceptEveryone(bob);

  await connectToPeer(alice);
  await alice.getByRole("button", { name: "Back to Home" }).click();
  await peerSettings(alice, "bob").click();
  await alice.getByRole("switch", { name: "Connect automatically" }).check();
  await alice.getByRole("button", { name: "Back" }).click();

  // The Beacon stops advertising a peer which left, so alice holds no address for
  // bob and nothing is reached.
  await signOut(bob);
  await expect(peerNamed(alice, "bob").getByLabel("Unavailable", { exact: true })).toBeVisible();

  // He is advertised again the moment he returns, and alice reaches him without
  // being asked and without leaving Home.
  await unlock(bob, "bob");
  await expect(peerNamed(alice, "bob").getByLabel("Connected", { exact: true })).toBeVisible();
});

test("a peer which bars us is no longer reached automatically", async ({ openVessel }) => {
  const alice = await openVessel("alice");
  const bob = await openVessel("bob");
  await acceptEveryone(alice);
  await acceptEveryone(bob);

  await connectToPeer(alice);
  await alice.getByRole("button", { name: "Back to Home" }).click();
  await peerSettings(alice, "bob").click();
  await alice.getByRole("switch", { name: "Connect automatically" }).check();

  // Withholding the registry bars alice, which is not something to dial through:
  // her own switch says so while she is looking at it.
  await peerSettings(bob, "alice").click();
  await bob.getByRole("switch", { name: "registry", exact: true }).uncheck();
  await expect(alice.getByRole("switch", { name: "Connect automatically" }))
    .not.toBeChecked();
});
