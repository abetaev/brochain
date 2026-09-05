import type { Locator, Page } from "@playwright/test";
import { acceptEveryone, connectToPeer, expect, test } from "./vessel.ts";

// A call is proven by frames arriving, not by the words on the page.
async function expectVideo(page: Page, label: string): Promise<void> {
  await expect.poll(
    async () => await page.getByLabel(label).evaluate(
      (element) => (element as HTMLVideoElement).videoWidth,
    ),
    { timeout: 30_000 },
  ).toBeGreaterThan(0);
}

// What is waiting reaches a reader as an avatar in the status bar of whatever
// view they are on, named after the thing that is waiting.
function notice(page: Page, waiting: string): Locator {
  return page.getByRole("button", { name: waiting, exact: true });
}

test("two people call each other, and the call outlives the view", async ({ openVessel }) => {
  const alice = await openVessel("alice");
  const bob = await openVessel("bob");
  await acceptEveryone(alice);
  await acceptEveryone(bob);

  // A call is placed from the conversation and stays there until it is answered.
  await connectToPeer(alice);
  await alice.getByRole("button", { name: "Call", exact: true }).click();
  await expect(alice.getByText("outgoing call")).toBeVisible();
  await expect(alice.getByRole("button", { name: "Cancel call" })).toBeVisible();

  // Bob is rung wherever he is, and consents before his camera is taken.
  await notice(bob, "alice is calling").click();
  await expect(bob.getByRole("heading", { name: "Chat with alice" })).toBeVisible();
  await expect(bob.getByText("incoming call")).toBeVisible();
  await bob.getByRole("button", { name: "Accept call" }).click();

  // Answering takes both of them to the call itself.
  await expect(alice.getByRole("heading", { name: "Call with bob" })).toBeVisible();
  await expect(bob.getByRole("heading", { name: "Call with alice" })).toBeVisible();
  await expect(alice.getByText("In a call with bob.")).toBeVisible();
  await expectVideo(alice, "Remote video");
  await expectVideo(bob, "Remote video");

  // Leaving the call view must not end the call.
  await alice.getByRole("button", { name: "Back", exact: true }).click();
  await expect(alice.getByRole("heading", { name: "Chat with bob" })).toBeVisible();
  await expect(alice.getByText("ongoing call")).toBeVisible();
  await alice.getByRole("button", { name: "Open call" }).click();
  await expectVideo(alice, "Remote video");

  await alice.getByRole("button", { name: "Mute microphone" }).click();
  await expect(alice.getByRole("button", { name: "Unmute microphone" })).toBeVisible();

  // Hanging up returns both of them to the conversation, where the call remains.
  await alice.getByRole("button", { name: "Hang up" }).click();
  await expect(alice.getByRole("heading", { name: "Chat with bob" })).toBeVisible();
  await expect(alice.getByText("call ended")).toBeVisible();
  await expect(notice(alice, "In a call with bob")).toBeHidden();

  await expect(bob.getByRole("heading", { name: "Chat with alice" })).toBeVisible();
  await expect(bob.getByText("call ended")).toBeVisible();
  await expect(bob.getByRole("alert")).toContainText("This peer ended the call.");
  await expect(notice(bob, "In a call with alice")).toBeHidden();
});
