import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectDirectory = dirname(fileURLToPath(import.meta.url));
const initializationMarker = ".i";
const dependencyFiles = ["package.json", "package-lock.json"];
const requiredExecutables = ["tsc", "vite", "vitest", "playwright"];

function executablePath(projectRoot: string, executable: string): string {
  return join(projectRoot, "node_modules", ".bin", executable);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function dependencyFingerprint(projectRoot = projectDirectory): Promise<string> {
  const hash = createHash("sha256");

  for (const file of dependencyFiles) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(join(projectRoot, file)));
    hash.update("\0");
  }

  return hash.digest("hex");
}

export async function needsInitialization(projectRoot = projectDirectory): Promise<boolean> {
  const markerPath = join(projectRoot, initializationMarker);

  if (!(await exists(markerPath))) {
    return true;
  }

  const executablesAvailable = await Promise.all(
    requiredExecutables.map((executable) => exists(executablePath(projectRoot, executable))),
  );

  if (!executablesAvailable.every(Boolean)) {
    return true;
  }

  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    return marker.fingerprint !== (await dependencyFingerprint(projectRoot));
  } catch {
    return true;
  }
}

function runCommand(
  command: string,
  commandArguments: string[],
  projectRoot: string,
): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, commandArguments, { cwd: projectRoot, stdio: "inherit" });

    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      const status = signal ?? `code ${code ?? "unknown"}`;
      reject(new Error(`${command} ${commandArguments.join(" ")} exited with ${status}.`));
    });
  });
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function installedCommand(command: string): string {
  return executablePath(projectDirectory, process.platform === "win32" ? `${command}.cmd` : command);
}

async function initializeProject(projectRoot = projectDirectory): Promise<boolean> {
  if (!(await needsInitialization(projectRoot))) {
    return false;
  }

  await runCommand(npmCommand(), ["install"], projectRoot);
  await runCommand(installedCommand("playwright"), ["install", "chromium"], projectRoot);
  await writeFile(
    join(projectRoot, initializationMarker),
    `${JSON.stringify({ fingerprint: await dependencyFingerprint(projectRoot) })}\n`,
  );
  return true;
}

async function runProjectCommand(command: string): Promise<void> {
  await initializeProject();

  if (command === "dev") {
    await runCommand(installedCommand("vite"), [], projectDirectory);
    return;
  }

  if (command === "prod") {
    await runCommand(installedCommand("tsc"), ["--noEmit"], projectDirectory);
    await runCommand(installedCommand("vite"), ["build"], projectDirectory);
    await runCommand(process.execPath, ["beacon/prod.ts"], projectDirectory);
    return;
  }

  if (command === "test") {
    await runCommand(installedCommand("vitest"), ["run"], projectDirectory);
    await runCommand(installedCommand("playwright"), ["test"], projectDirectory);
    return;
  }

  throw new Error(`Unknown project command: ${command}`);
}

async function runFromCommandLine(): Promise<void> {
  try {
    await runProjectCommand(process.argv[2] ?? "");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runFromCommandLine();
}
