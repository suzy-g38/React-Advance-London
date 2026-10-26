// Runs axe-core on the page with the combobox open, while aria-expanded is wrong. Needs `npm run dev`.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const APP_URL = process.env.APP_URL || "http://localhost:5173";
const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  await page.goto(APP_URL);
  const input = page.locator('input[role="combobox"]');
  await input.click();
  await page.locator('[role="listbox"]').waitFor();

  console.log(`combobox: open, list visible, aria-expanded="${await input.getAttribute("aria-expanded")}"`);
  await page.addScriptTag({ content: axeSource });

  const runs = [
    { name: "WCAG 2.x A/AA rules", options: { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } },
    { name: "all rules, including best practices", options: {} },
  ];
  let failed = false;
  for (const run of runs) {
    const results = await page.evaluate((options) => window.axe.run(document, options), run.options);
    console.log(`\naxe-core ${results.testEngine.version}, ${run.name}: ${results.violations.length} violations, ${results.passes.length} rules passed`);
    for (const v of results.violations) {
      failed = true;
      console.log(`  ✗ ${v.id} (${v.impact}): ${v.help}`);
      for (const node of v.nodes.slice(0, 3)) console.log(`      ${node.target.join(" ")}`);
    }
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  await browser.close();
}
