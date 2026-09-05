import { expect, test } from "./vessel.ts";

interface ManifestIcon {
  readonly src: string;
  readonly sizes?: string;
  readonly type?: string;
}

interface Manifest {
  readonly name?: string;
  readonly display?: string;
  readonly start_url?: string;
  readonly icons?: readonly ManifestIcon[];
}

function rasterIcon(manifest: Manifest, sizes: string): ManifestIcon | undefined {
  return manifest.icons
    ?.find((icon) => icon.sizes === sizes && icon.type === "image/png");
}

// A browser offers installation for a page that links a manifest it accepts, and
// the address another device opens is the development one, which served neither
// a manifest nor a worker until it was asked to.
test("development serves what installing the application needs", async ({ page }) => {
  const registration = page.context().waitForEvent("serviceworker");
  await page.goto("/");

  await expect(page.locator('link[rel="manifest"]'))
    .toHaveAttribute("href", "/manifest.webmanifest");
  const manifest: Manifest = await page.evaluate(
    async () => await (await fetch("/manifest.webmanifest")).json(),
  );
  // Workflows serve development, which installs under a name of its own so an
  // installed one says which of the two it is.
  expect(manifest.name).toBe("brochain [dev]");
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");
  expect(rasterIcon(manifest, "192x192")).toBeDefined();
  expect(rasterIcon(manifest, "512x512")).toBeDefined();

  // Every icon a manifest names is served, which is what the public directory is for.
  for (const icon of manifest.icons ?? []) {
    const response = await page.request.get(`/${icon.src}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/");
  }

  // The page registers the worker itself, over the connection development
  // reloads through, so its arrival is awaited rather than requested.
  await registration;
  await expect.poll(async () =>
    await page.evaluate(() => navigator.serviceWorker.controller !== null)
  ).toBe(true);
});
