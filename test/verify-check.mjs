// Needs `npm run dev` and `npm run sidecar` running.

import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { AUDIT_PATCH, GOOD_PATCH, REVIEW_PATCH, SCOPE_PATCH } from "../src/fixtures.js";
import { verifyCandidate, closeBrowser } from "../server/verifier.js";

const CASES = [
  { name: "good patch passes the accessibility tree check", patch: GOOD_PATCH, expectPass: true },
  {
    name: "failure 1 recreated (aria-live on the input, bug untouched) fails the check",
    patch: REVIEW_PATCH,
    expectPass: false,
  },
  {
    name: 'failure 3 recreated (aria-expanded="true") fails the check',
    patch: AUDIT_PATCH,
    expectPass: false,
  },
  {
    name: "patch that still reads the stale copy fails the check",
    patch: { ...GOOD_PATCH, replacement: '        aria-expanded={expanded ? "true" : "false"}' },
    expectPass: false,
  },
  {
    name: "schema-valid patch that wrecks the markup fails the check",
    // Replaces the `<input` line, so the input's attributes become plain text.
    patch: { ...GOOD_PATCH, lineRange: [33, 33] },
    expectPass: false,
  },
  {
    name: "schema-valid patch that doesn't compile fails the check",
    // Replaces a statement in the function body with an attribute.
    patch: { ...GOOD_PATCH, lineRange: [13, 13] },
    expectPass: false,
  },
];

const socket = new WebSocket("ws://localhost:8787");
const pending = new Map();

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type === "verify-result") pending.get(message.requestId)?.(message);
});

socket.on("error", (error) => {
  console.error("socket error (is `npm run sidecar` running?):", error.message);
  process.exit(1);
});

socket.on("open", async () => {
  let failed = false;
  for (const [index, testCase] of CASES.entries()) {
    const started = Date.now();
    const result = await new Promise((resolve) => {
      pending.set(index, resolve);
      socket.send(JSON.stringify({ type: "verify-patch", requestId: index, patch: testCase.patch }));
    });
    const ok = result.passed === testCase.expectPass;
    failed ||= !ok;
    console.log(`${ok ? "PASS" : "FAIL"}: ${testCase.name} (${Date.now() - started} ms)`);
    for (const step of result.steps ?? []) {
      console.log(`    ${step.state.padEnd(13)} expanded: ${String(step.actual).padEnd(6)} ${step.ok ? "✓" : "✗"}`);
    }
    if (result.reason) console.log(`    reason: ${result.reason}`);
  }
  socket.close();

  // Failure 2 never gets past the schema; apply it directly to show what the tree check alone catches.
  const scope = await verifyCandidate(writeUnchecked(SCOPE_PATCH));
  await closeBrowser();
  const wrongSteps = scope.steps.filter((step) => !step.ok).map((step) => step.state);
  const ok = !scope.passed && wrongSteps.join() === "option picked";
  failed ||= !ok;
  console.log(`${ok ? "PASS" : "FAIL"}: failure 2 recreated, applied without the schema, breaks only when an option is picked`);
  for (const step of scope.steps) {
    console.log(`    ${step.state.padEnd(13)} expanded: ${String(step.actual).padEnd(6)} ${step.ok ? "✓" : "✗"}`);
  }

  process.exitCode = failed ? 1 : 0;
  console.log(failed ? "\nSome checks failed." : "\nAll checks passed.");
});

function writeUnchecked(patch) {
  const lines = readFileSync(new URL("../src/Combobox.jsx", import.meta.url), "utf8").split("\n");
  const [start, end] = patch.lineRange;
  lines.splice(start - 1, end - start + 1, ...patch.replacement.split("\n"));
  const id = randomBytes(4).toString("hex");
  writeFileSync(new URL(`../src/candidates/Combobox.${id}.jsx`, import.meta.url), lines.join("\n"));
  return id;
}
