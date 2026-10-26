import { validatePatch } from "../src/schema.js";
import { AUDIT_PATCH, GOOD_PATCH, REVIEW_PATCH, SCOPE_PATCH } from "../src/fixtures.js";
import { completedFields } from "../src/streamingJson.js";
import { readAndValidateStream, RESET } from "../src/patchPipeline.js";

function assert(condition, message) {
  if (!condition) {
    console.error("FAIL:", message);
    process.exitCode = 1;
  } else {
    console.log("PASS:", message);
  }
}

const accepts = (patch) => validatePatch(patch).success;

assert(accepts(REVIEW_PATCH), "failure 1 recreated (aria-live on the input) is accepted by the schema (verification must catch it)");

const scopeResult = validatePatch(SCOPE_PATCH);
assert(scopeResult.success === false, "failure 2 recreated (adds its own state) is rejected");
if (!scopeResult.success) {
  console.log("  reason:", scopeResult.error.issues.map((i) => i.message).join("; "));
}

assert(
  !accepts({ ...GOOD_PATCH, replacement: '        aria-label="City combobox"', ariaAttributesTouched: ["aria-label"] }),
  "patch touching aria-label (outside the allowlist) is rejected"
);

assert(accepts(GOOD_PATCH), "good patch (aria-expanded, in allowlist) is accepted");

assert(accepts(AUDIT_PATCH), 'failure 3 recreated (aria-expanded="true") is accepted by the schema (verification must catch it)');

assert(!accepts({ ...GOOD_PATCH, lineRange: [50, 10] }), "malformed lineRange (end before start) is rejected");
assert(!accepts({ ...GOOD_PATCH, lineRange: [30, 39] }), "lineRange longer than 5 lines is rejected");
assert(!accepts({ ...GOOD_PATCH, path: "../../etc/hosts" }), "patch path outside src/ is rejected");
assert(!accepts({ ...GOOD_PATCH, path: "src/../../etc/evil.jsx" }), "path escaping src/ with .. is rejected");

assert(
  !accepts({ ...GOOD_PATCH, replacement: 'onClick={() => fetch("https://evil.example")}' }),
  "replacement with arbitrary code (onClick + fetch) is rejected"
);
assert(
  !accepts({ ...GOOD_PATCH, replacement: "aria-expanded={steal()}" }),
  "replacement calling a function inside an ARIA attribute is rejected"
);
assert(
  !accepts({ ...GOOD_PATCH, replacement: "const expanded = open;" }),
  "replacement that is not an attribute line is rejected"
);
assert(
  !accepts({ ...GOOD_PATCH, replacement: 'aria-expanded={open}\naria-hidden="true"' }),
  "replacement touching an undeclared attribute is rejected"
);

const partial = completedFields('{"path": "src/A.jsx", "lineRange": [3');
assert(
  JSON.stringify(partial) === '{"path":"src/A.jsx"}',
  "a half-streamed patch yields only its completed fields"
);
assert(
  completedFields('{"replacement": "a=\\"}\\"", "x": 1}').replacement === 'a="}"',
  "escaped quotes and braces inside a string don't end the field early"
);

function streamOf(...chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}
function chunked(text, size = 7) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

const seen = [];
const early = await readAndValidateStream(streamOf(...chunked(JSON.stringify(SCOPE_PATCH, null, 2))), {
  onField: (name) => seen.push(name),
});
assert(
  !early.complete && early.field === "lineRange" && !seen.includes("replacement"),
  "failure 2 is rejected at lineRange, before its replacement code is read"
);

const whole = await readAndValidateStream(streamOf(...chunked(JSON.stringify(GOOD_PATCH))));
assert(
  whole.complete && JSON.stringify(whole.patch) === JSON.stringify(GOOD_PATCH),
  "a good patch streams through every field check intact"
);

const reset = await readAndValidateStream(streamOf('{"path": "src/A', RESET, ...chunked(JSON.stringify(GOOD_PATCH))));
assert(reset.complete, "a reset discards partial output and reads the fallback cleanly");

console.log(process.exitCode === 1 ? "\nSome checks failed." : "\nAll checks passed.");
