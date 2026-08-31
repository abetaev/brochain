import { appendFile, readFile, writeFile } from "node:fs/promises";

// Neither coverage report has a theme of its own, so both follow the reader's.
// Hue rotation keeps covered green and uncovered red recognisable once inverted,
// and the workflow report's own dark header is turned back.
export const systemTheme = `@media (prefers-color-scheme: dark) {
  html { background-color: #fff; filter: invert(1) hue-rotate(180deg); }
  img, video, .mcr-header { filter: invert(1) hue-rotate(180deg); }
}
`;

export async function followSystemTheme(stylesheet: string): Promise<void> {
  const current = await readFile(stylesheet, "utf8").catch(() => undefined);
  if (current === undefined || current.includes("prefers-color-scheme")) return;
  await appendFile(stylesheet, `\n${systemTheme}`);
}

export async function followSystemThemeInPage(page: string): Promise<void> {
  const html = await readFile(page, "utf8");
  if (html.includes("prefers-color-scheme")) return;
  await writeFile(page, html.replace("</head>", `<style>\n${systemTheme}</style>\n</head>`));
}
