import { readFile } from "node:fs/promises";
import {
  connectToPeer,
  expect,
  password,
  peerOffering,
  signOut,
  test,
} from "./vessel.ts";

test("two people meet through the Beacon, talk, and leave", async ({ openVessel }) => {
  const alice = await openVessel("alice");
  const bob = await openVessel("bob");

  await connectToPeer(alice, "bob");
  await alice.getByLabel("Message").fill("hello from alice");
  await alice.getByRole("button", { name: "Send message" }).click();
  await expect(alice.getByText("hello from alice")).toBeVisible();

  await peerOffering(bob, "Chat").getByRole("button", { name: "Chat" }).click();
  await expect(bob.getByRole("heading", { name: "Chat with alice" })).toBeVisible();
  await expect(bob.getByText("hello from alice")).toBeVisible();

  await bob.getByLabel("Message").fill("hello from bob");
  await bob.getByRole("button", { name: "Send message" }).click();
  await expect(alice.getByText("hello from bob")).toBeVisible();

  await signOut(bob);
  const [exported] = await Promise.all([
    bob.waitForEvent("download"),
    bob.getByRole("button", { name: "Export" }).click(),
  ]);
  expect(exported.suggestedFilename()).toBe("bob.brochain-account.json");
  expect(JSON.parse(await readFile(await exported.path(), "utf8")))
    .toMatchObject({ username: "bob" });

  await signOut(alice);
  await alice.locator("summary").filter({ hasText: "Delete" }).click();
  await alice.getByLabel("Password").fill(password);
  await alice.getByRole("button", { name: "Delete account" }).click();
  await expect(alice.getByRole("heading", { name: "Create an account" })).toBeVisible();
});
