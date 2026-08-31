import { expect, test } from "./vessel.ts";
import type { Page } from "@playwright/test";

// A discovered peer is listed by its peer ID until it is connected and identified,
// so it is found by the action offered rather than by name.
function peerOffering(page: Page, action: "Connect" | "Chat") {
  return page.getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: action, exact: true }) });
}

test("two people find each other through the Beacon and exchange a message", async ({
  openVessel,
}) => {
  const alice = await openVessel("alice");
  const bob = await openVessel("bob");

  await expect(async () => {
    await alice.getByRole("button", { name: "Refresh peers" }).click();
    await expect(peerOffering(alice, "Connect")).toBeVisible({ timeout: 5_000 });
  }).toPass();

  await peerOffering(alice, "Connect").getByRole("button", { name: "Connect" }).click();
  await expect(alice.getByRole("heading", { name: "Chat with bob" })).toBeVisible();

  await alice.getByLabel("Message").fill("hello from alice");
  await alice.getByRole("button", { name: "Send message" }).click();
  await expect(alice.getByText("hello from alice")).toBeVisible();

  await peerOffering(bob, "Chat").getByRole("button", { name: "Chat" }).click();
  await expect(bob.getByRole("heading", { name: "Chat with alice" })).toBeVisible();
  await expect(bob.getByText("hello from alice")).toBeVisible();

  await bob.getByLabel("Message").fill("hello from bob");
  await bob.getByRole("button", { name: "Send message" }).click();
  await expect(alice.getByText("hello from bob")).toBeVisible();
});
