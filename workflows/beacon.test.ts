import type { Page } from "@playwright/test";
import {
  alternativeBeaconAddress,
  alternativeBeaconUrl,
  relaylessVesselAddress,
} from "../playwright.config.ts";
import { expect, peerDisconnected, test } from "./vessel.ts";

async function connectDirectly(page: Page, address: string): Promise<void> {
  await expect(page.getByRole("alert")).toContainText("Peer networking is unavailable");
  await expect(page.getByText("No peers are currently known.")).toBeVisible();

  await page.getByRole("button", { name: "Connect directly" }).click();
  await page.getByLabel("Peer address").fill(address);
  await page.getByRole("button", { name: "Connect", exact: true }).click();

  // The Beacon offers no conversation, so it is listed as a plain connected peer.
  await expect(
    page.getByRole("listitem").filter({ has: page.getByLabel("Connected", { exact: true }) }),
  ).toBeVisible();
}

test("people whose Vessel host offers no Beacon reach another and meet there", async ({
  openVessel,
}) => {
  const alice = await openVessel("alice", relaylessVesselAddress);
  await connectDirectly(alice, alternativeBeaconUrl);

  const bob = await openVessel("bob", relaylessVesselAddress);
  await connectDirectly(bob, alternativeBeaconAddress);

  await expect(async () => {
    await alice.getByRole("button", { name: "Refresh peers" }).click();
    await expect(peerDisconnected(alice)).toBeVisible({ timeout: 5_000 });
  }).toPass();
});
