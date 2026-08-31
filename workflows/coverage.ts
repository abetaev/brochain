import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import MonocartCoverage from "monocart-coverage-reports";
import { followSystemThemeInPage } from "../coverage.ts";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportDirectory = resolve(projectDirectory, "coverage/workflows");

const frontendRoot = "vessel/frontend";

// The development server serves the frontend from its own root and everything
// else through `/@fs`, so reported files are named by their place in the project.
function projectPath(distFile: string): string {
  const served = distFile.replace(/^[^/]+\//, "");
  return served.startsWith("@fs/")
    ? relative(projectDirectory, `/${served.slice("@fs/".length)}`)
    : join(frontendRoot, served);
}

// Workflow coverage is reported on its own, so what real use reaches stays
// visible separately from what the lower-level tests prove.
const options = {
  name: "brochain workflows",
  outputDir: reportDirectory,
  reports: ["v8", "console-summary"],
  entryFilter: (entry: { url: string }) =>
    !entry.url.includes("node_modules") &&
    !entry.url.includes("/@vite/") &&
    !entry.url.includes("/@solid-refresh"),
  sourceFilter: (path: string) =>
    !path.includes("node_modules") && !path.endsWith(".test.ts"),
  sourcePath: (filePath: string, info: { distFile?: string }) =>
    info.distFile === undefined ? filePath : projectPath(info.distFile),
  onEnd: async () => await followSystemThemeInPage(resolve(reportDirectory, "index.html")),
};

export function workflowCoverage() {
  return MonocartCoverage(options);
}

export default async function collectWorkflowCoverage(): Promise<() => Promise<void>> {
  await workflowCoverage().cleanCache();
  return async () => {
    await workflowCoverage().generate();
  };
}
