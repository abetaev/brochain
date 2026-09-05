import type { CDPSession, Page } from "@playwright/test";
import { expect, password, selectAccount, signOut, test } from "./vessel.ts";

// A virtual authenticator stands in for the one a device has of its own, and this
// one evaluates the pseudo-random function the wrapping's key is derived from.
async function attachAuthenticator(
  page: Page,
): Promise<{ devices: CDPSession; authenticatorId: string }> {
  const devices = await page.context().newCDPSession(page);
  await devices.send("WebAuthn.enable");
  const { authenticatorId } = await devices.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
      isUserVerified: true,
    },
  });
  return { devices, authenticatorId };
}

const thisDevice = { name: "This device", exact: true } as const;

async function enrol(page: Page, wanted: boolean): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const control = page.getByRole("switch", thisDevice);
  // The switch decides nothing while the account has yet to answer and while a
  // decision is being written, so it is read and moved only once it settles —
  // and a switch read too early reads as off, which is a decision of its own.
  await expect(control).toBeEnabled();
  await (wanted ? control.check() : control.uncheck());
  await expect(control).toBeEnabled();
  await expect(control).toBeChecked({ checked: wanted });
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
}

test("an enrolled device unlocks the account, and removing it gives the password back", async ({
  openVessel,
}) => {
  const page = await openVessel("ada");
  await attachAuthenticator(page);

  await enrol(page, true);
  await signOut(page);

  // The ceremony runs as Sign In opens, so nothing is typed to get back in.
  await selectAccount(page, "ada");
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();

  // The same control removes it, and the account is a password account again.
  await enrol(page, false);
  await signOut(page);
  await selectAccount(page, "ada");
  await expect(page.getByRole("button", { name: "Try this device again" })).toHaveCount(0);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Unlock account" }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
});

test("a device which declines leaves the password", async ({ openVessel }) => {
  const page = await openVessel("bea");
  const { devices, authenticatorId } = await attachAuthenticator(page);

  await enrol(page, true);
  await signOut(page);

  // The reader is not verified, so the ceremony refuses and says what remains.
  await devices.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
  await selectAccount(page, "bea");
  await expect(page.getByRole("alert")).toContainText("Enter your password");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Unlock account" }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();

  // A virtual authenticator which has refused once refuses thereafter whatever it
  // is told about the reader, so what a recovered device does is not provable here.
});
