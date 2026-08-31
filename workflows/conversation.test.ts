import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, password, test } from "./vessel.ts";

const fileName = "notes.txt";
const fileContents = "bytes bob shared with alice";

// A discovered peer is listed by its peer ID until it is connected and identified,
// so it is found by the action offered rather than by name.
function peerOffering(page: Page, action: "Connect" | "Chat") {
  return page.getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: action, exact: true }) });
}

test("two people meet through the Beacon, share a message and a file, then leave", async ({
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

  await bob.getByLabel("Send a file").setInputFiles({
    name: fileName,
    mimeType: "text/plain",
    buffer: Buffer.from(fileContents),
  });

  const received = alice.getByRole("link", { name: `Download ${fileName}` });
  await expect(received).toBeVisible();
  await expect(bob.getByRole("link", { name: `Download ${fileName}` })).toBeVisible();

  const [download] = await Promise.all([alice.waitForEvent("download"), received.click()]);
  expect(await readFile(await download.path(), "utf8")).toBe(fileContents);

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

async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Back to Home" }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
}
