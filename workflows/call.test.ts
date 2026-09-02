import type { Locator, Page } from "@playwright/test";
import { connectToPeer, expect, test } from "./vessel.ts";

// A call is proven by frames arriving, not by the words on the page.
async function expectVideo(page: Page, label: string): Promise<void> {
  await expect.poll(
    async () => await page.getByLabel(label).evaluate(
      (element) => (element as HTMLVideoElement).videoWidth,
    ),
    { timeout: 30_000 },
  ).toBeGreaterThan(0);
}

function banner(page: Page): Locator {
  return page.getByRole("status");
}

test("two people call each other, and the call outlives the view", async ({ openVessel }) => {
  const alice = await openVessel("alice");
  const bob = await openVessel("bob");

  await connectToPeer(alice, "bob");
  await alice.getByRole("button", { name: "Call", exact: true }).click();
  await expect(alice.getByRole("heading", { name: "Call with bob" })).toBeVisible();

  // Bob is rung wherever he is, and consents before his camera is taken.
  await expect(banner(bob)).toContainText("alice is calling");
  await banner(bob).getByRole("button", { name: "Accept call" }).click();

  await expect(alice.getByText("In a call with bob.")).toBeVisible();
  await expect(bob.getByText("In a call with alice.")).toBeVisible();
  await expectVideo(alice, "Remote video");
  await expectVideo(bob, "Remote video");

  // Leaving the call view must not end the call.
  await alice.getByRole("button", { name: "Back", exact: true }).click();
  await expect(alice.getByRole("heading", { name: "Chat with bob" })).toBeVisible();
  await expect(banner(alice)).toContainText("In a call with bob.");
  await banner(alice).getByRole("button", { name: "Open call" }).click();
  await expectVideo(alice, "Remote video");

  await alice.getByRole("button", { name: "Mute microphone" }).click();
  await expect(alice.getByRole("button", { name: "Unmute microphone" })).toBeVisible();

  await alice.getByRole("button", { name: "Hang up" }).click();
  await expect(alice.getByRole("heading", { name: "Chat with bob" })).toBeVisible();
  await expect(banner(alice)).toBeHidden();

  await expect(bob.getByRole("alert")).toContainText("This peer ended the call.");
  await bob.getByRole("button", { name: "Back", exact: true }).click();
  await expect(bob.getByRole("heading", { name: "Chat with alice" })).toBeVisible();
  await expect(banner(bob)).toBeHidden();
});
