import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { followSystemTheme } from "./coverage.ts";

const projectDirectory = dirname(fileURLToPath(import.meta.url));
const initializationMarker = ".i";
const dependencyFiles = ["package.json", "package-lock.json"];
const requiredExecutables = ["tsc", "vite", "vitest", "playwright"];
// The server keeps releases where a service and a web server can both reach them, and
// both already state this, so a third statement could only ever disagree with them.
const deploymentRoot = "/srv/brochain";
// A release is what the server runs: the built application, the sources Node runs
// directly, and what installing their dependencies needs.
const releaseContents = ["dist", "beacon", "common", "package.json", "package-lock.json"];
const releaseExclusions = ["--exclude=*.test.ts", "--exclude=beacon/dev.ts"];

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

interface Deployment {
  readonly host: string;
  readonly origin: string;
}

// Where a deployment lives and what it answers on belong to whoever deploys rather
// than to the project, so they are read from beside it and never committed.
export function deploymentSettings(path = join(projectDirectory, ".env")): Deployment {
  try {
    process.loadEnvFile(path);
  } catch {
    throw new Error(`Deployment is configured in ${path}, which is absent.`);
  }

  const { DEPLOY_HOST: host, DEPLOY_ORIGIN: origin } = process.env;

  if (host === undefined || origin === undefined) {
    throw new Error("Deployment needs DEPLOY_HOST and DEPLOY_ORIGIN in .env.");
  }

  return { host, origin };
}

function runRemoteCommand(deployment: Deployment, command: string): Promise<void> {
  return runCommand("ssh", [deployment.host, command], projectDirectory);
}

// A release is streamed to the server, so neither machine keeps an archive of it. The
// two processes are joined here rather than by a shell pipeline, which the platforms
// the other commands accommodate do not share.
function sendRelease(deployment: Deployment, directory: string): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const archive = spawn("tar", ["-cz", ...releaseExclusions, ...releaseContents], {
      cwd: projectDirectory,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const extract = spawn("ssh", [deployment.host, `tar -xz -C ${directory}`], {
      cwd: projectDirectory,
      stdio: ["pipe", "inherit", "inherit"],
    });

    archive.stdout.pipe(extract.stdin);
    archive.once("error", reject);
    extract.once("error", reject);
    archive.once("close", (code) => {
      if (code !== 0) reject(new Error(`Archiving the release exited with code ${code}.`));
    });
    extract.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Sending the release exited with code ${code}.`));
    });
  });
}

// A deployment which serves what was just built is the only evidence a deploy arrived,
// because every step before it succeeded on the machine which shipped it.
async function confirmDeployment(deployment: Deployment): Promise<void> {
  const response = await fetch(deployment.origin, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`${deployment.origin} answered ${response.status} after the deploy.`);
  }

  const built = await readFile(join(projectDirectory, "dist", "index.html"), "utf8");

  if (await response.text() !== built) {
    throw new Error(`${deployment.origin} does not serve the release just sent.`);
  }
}

async function deployRelease(deployment: Deployment): Promise<void> {
  const release = new Date().toISOString().replace(/[-:]|\.\d+/g, "");
  const directory = `${deploymentRoot}/releases/${release}`;

  await runRemoteCommand(deployment, `mkdir -p ${directory}`);
  await sendRelease(deployment, directory);
  await runRemoteCommand(deployment, `cd ${directory} && npm ci --omit=dev --ignore-scripts`);
  // Linking over a link which exists creates one inside it, so the new link is made
  // beside the current one and then replaces it in a single step.
  await runRemoteCommand(
    deployment,
    `ln -sfn ${directory} ${deploymentRoot}/next` +
      ` && mv -T ${deploymentRoot}/next ${deploymentRoot}/current`,
  );
  await runRemoteCommand(deployment, "systemctl --user restart brochain");
  // The release before this one stays, so a rollback is relinking it.
  await runRemoteCommand(
    deployment,
    `ls -1dt ${deploymentRoot}/releases/* | tail -n +3 | xargs -r rm -rf`,
  );
  await confirmDeployment(deployment);
}

async function runTests(): Promise<void> {
  await runCommand(installedCommand("vitest"), ["run"], projectDirectory);
  await followSystemTheme(join(projectDirectory, "coverage/unit/base.css"));
  await runCommand(installedCommand("playwright"), ["test"], projectDirectory);
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
    await runCommand(process.execPath, ["beacon/main.ts"], projectDirectory);
    return;
  }

  if (command === "test") {
    await runTests();
    return;
  }

  if (command === "deploy") {
    // Nothing is built or run before the deployment is known, so a missing setting
    // costs a moment rather than the suite.
    const deployment = deploymentSettings();
    await runCommand(installedCommand("tsc"), ["--noEmit"], projectDirectory);
    await runTests();
    await runCommand(installedCommand("vite"), ["build"], projectDirectory);
    await deployRelease(deployment);
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
