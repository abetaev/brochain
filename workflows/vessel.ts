import { test as base, expect, type Page } from "@playwright/test";
import { workflowCoverage } from "./coverage.ts";

const password = "correct horse battery staple";

type Fixtures = {
  openVessel: (username: string) => Promise<Page>;
};

// Every Vessel a workflow opens is a separate browser context, so accounts and
// their storage never leak between people.
export const test = base.extend<Fixtures>({
  openVessel: async ({ browser }, use) => {
    const opened: Page[] = [];

    await use(async (username) => {
      const page = await (await browser.newContext()).newPage();
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
      opened.push(page);
      await signIn(page, username);
      return page;
    });

    const coverage = workflowCoverage();
    for (const page of opened) {
      await coverage.add(await page.coverage.stopJSCoverage());
    }
  },
});

export { expect };

async function signIn(page: Page, username: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("heading", { name: "Create an account" }).waitFor();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
}
