import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dependencyFingerprint, deploymentSettings, needsInitialization } from "./main.ts";

const temporaryProjects: string[] = [];

async function createProject() {
  const project = await mkdtemp(join(tmpdir(), "brochain-main-"));
  temporaryProjects.push(project);
  await writeFile(join(project, "package.json"), '{"name":"test"}\n');
  await writeFile(join(project, "package-lock.json"), '{"lockfileVersion":3}\n');
  await mkdir(join(project, "node_modules", ".bin"), { recursive: true });

  for (const executable of ["tsc", "vite", "vitest", "playwright"]) {
    await writeFile(join(project, "node_modules", ".bin", executable), "");
  }

  return project;
}

afterEach(async () => {
  delete process.env.DEPLOY_HOST;
  delete process.env.DEPLOY_ORIGIN;
  const removeProjects = temporaryProjects
    .splice(0)
    .map((project) => rm(project, { force: true, recursive: true }));
  await Promise.all(removeProjects);
});

describe("project initialization", () => {
  it("requires initialization when its marker is absent", async () => {
    expect(await needsInitialization(await createProject())).toBe(true);
  });

  it("accepts a matching marker and invalidates it when dependencies change", async () => {
    const project = await createProject();
    const fingerprint = await dependencyFingerprint(project);
    await writeFile(join(project, ".i"), `${JSON.stringify({ fingerprint })}\n`);

    expect(await needsInitialization(project)).toBe(false);

    await writeFile(join(project, "package-lock.json"), '{"lockfileVersion":4}\n');
    expect(await needsInitialization(project)).toBe(true);
  });

  it("requires initialization when an installed executable is missing", async () => {
    const project = await createProject();
    const fingerprint = await dependencyFingerprint(project);
    await writeFile(join(project, ".i"), `${JSON.stringify({ fingerprint })}\n`);
    await rm(join(project, "node_modules", ".bin", "vite"));

    expect(await needsInitialization(project)).toBe(true);
  });
});

describe("deployment settings", () => {
  async function settingsFile(contents: string): Promise<string> {
    const project = await mkdtemp(join(tmpdir(), "brochain-deploy-"));
    temporaryProjects.push(project);
    const path = join(project, ".env");
    await writeFile(path, contents);
    return path;
  }

  it("reports where a deployment is configured when it is absent", async () => {
    const path = join(await settingsFile(""), "..", "absent");

    expect(() => deploymentSettings(path)).toThrowError(/absent/);
  });

  it("reports what a deployment needs when a setting is missing", async () => {
    const path = await settingsFile("DEPLOY_ORIGIN=https://example.com\n");

    expect(() => deploymentSettings(path)).toThrowError(/DEPLOY_HOST/);
  });

  it("takes the server and the address it answers on", async () => {
    const path = await settingsFile(
      "DEPLOY_HOST=someone@example.com\nDEPLOY_ORIGIN=https://example.com\n",
    );

    expect(deploymentSettings(path)).toEqual({
      host: "someone@example.com",
      origin: "https://example.com",
    });
  });
});
