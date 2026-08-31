import { test as base, expect, type Page } from "@playwright/test";
import { workflowCoverage } from "./coverage.ts";

export const password = "correct horse battery staple";

type Fixtures = {
  openVessel: (username: string, origin?: string) => Promise<Page>;
};

// Every Vessel a workflow opens is a separate browser context, so accounts and
// their storage never leak between people.
export const test = base.extend<Fixtures>({
  openVessel: async ({ browser }, use) => {
    const opened: Page[] = [];

    await use(async (username, origin = "/") => {
      const page = await (await browser.newContext()).newPage();
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
      opened.push(page);
      await page.goto(origin);
      await createAccount(page, username);
      return page;
    });

    // Closing each context ends its Vessel, so one workflow's peers never linger
    // on the Beacon while the next one runs.
    const coverage = workflowCoverage();
    for (const page of opened) {
      await coverage.add(await page.coverage.stopJSCoverage());
      await page.context().close();
    }
  },
});

export { expect };

export async function createAccount(page: Page, username: string): Promise<void> {
  await page.getByRole("heading", { name: "Create an account" }).waitFor();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
}

export async function unlock(page: Page, username: string): Promise<void> {
  await page.getByRole("listitem").filter({ hasText: username })
    .getByRole("button", { name: "Use" }).click();
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Unlock account" }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
}

export async function signOut(page: Page): Promise<void> {
  const home = page.getByRole("button", { name: "Back to Home" });
  if (await home.isVisible()) await home.click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Choose an account" })).toBeVisible();
}

// A peer is listed by its identified name once known, and by its peer ID until then,
// so a workflow finds it either by that name or by the action offered.
export function peerNamed(page: Page, name: string) {
  return page.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });
}

export function peerOffering(page: Page, action: "Connect" | "Chat") {
  return page.getByRole("listitem")
    .filter({ has: page.getByRole("button", { name: action, exact: true }) });
}

export async function connectToPeer(page: Page, name: string): Promise<void> {
  await expect(async () => {
    await page.getByRole("button", { name: "Refresh peers" }).click();
    await expect(peerOffering(page, "Connect")).toBeVisible({ timeout: 5_000 });
  }).toPass();
  await peerOffering(page, "Connect").getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("heading", { name: `Chat with ${name}` })).toBeVisible();
}
