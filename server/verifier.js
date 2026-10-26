import { chromium } from "playwright-core";

const APP_URL = process.env.APP_URL || "http://localhost:5173";
const STEP_TIMEOUT_MS = 5000;

let browserPromise = null;

function getBrowser() {
  browserPromise ??= chromium.launch({ channel: "chrome", headless: true }).catch((error) => {
    browserPromise = null;
    throw error;
  });
  return browserPromise;
}

export async function warmUp() {
  await getBrowser();
}

export async function closeBrowser() {
  if (browserPromise) await (await browserPromise).close();
}

async function readExpanded(cdp) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const combobox = nodes.find((node) => node.role?.value === "combobox");
  if (!combobox) return "no combobox in the tree";
  const expanded = combobox.properties?.find((property) => property.name === "expanded");
  return expanded ? expanded.value.value : "not exposed";
}

export async function verifyCandidate(candidateId) {
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const cdp = await context.newCDPSession(page);
    await page.goto(`${APP_URL}/verify.html?candidate=${candidateId}`, { timeout: STEP_TIMEOUT_MS });

    const input = page.locator('input[role="combobox"]');
    const list = page.locator('[role="listbox"]');

    const rendered = await page
      .locator("#root > *")
      .first()
      .waitFor({ timeout: STEP_TIMEOUT_MS })
      .then(
        () => true,
        () => false
      );
    if (!rendered || (await page.locator("[data-verify-error]").count()) > 0) {
      return { passed: false, steps: [], reason: "the patched component did not load" };
    }
    if ((await input.count()) === 0) {
      return { passed: false, steps: [], reason: "the patched component no longer renders a combobox" };
    }

    const steps = [];
    const record = async (state, expected) => {
      const actual = await readExpanded(cdp);
      steps.push({ state, expected, actual, ok: actual === expected });
    };

    await record("closed", false);
    await input.click();
    await list.waitFor({ timeout: STEP_TIMEOUT_MS });
    await record("open", true);
    await input.click();
    await list.waitFor({ state: "detached", timeout: STEP_TIMEOUT_MS });
    await record("closed again", false);
    // The second way the list closes: picking an option.
    await input.click();
    await list.waitFor({ timeout: STEP_TIMEOUT_MS });
    await page.locator('[role="option"]').first().click();
    await list.waitFor({ state: "detached", timeout: STEP_TIMEOUT_MS });
    await record("option picked", false);

    const failed = steps.find((step) => !step.ok);
    return {
      passed: !failed,
      steps,
      reason: failed
        ? `when the combobox is ${failed.state}, the accessibility tree says expanded: ${failed.actual}`
        : undefined,
    };
  } finally {
    await context.close();
  }
}
