import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { connectToPeer, expect, peerOffering, test } from "./vessel.ts";

const fileName = "notes.txt";
const fileContents = "bytes bob shared with alice";

test("one person sends a file and the other downloads it", async ({ openVessel }) => {
  const alice = await openVessel("alice");
  const bob = await openVessel("bob");

  await connectToPeer(alice, "bob");
  await peerOffering(bob, "Chat").getByRole("button", { name: "Chat" }).click();
  await expect(bob.getByRole("heading", { name: "Chat with alice" })).toBeVisible();

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
});
