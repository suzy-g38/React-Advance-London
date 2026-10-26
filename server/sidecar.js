import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import { GoogleGenAI, ThinkingLevel, FinishReason } from "@google/genai";
import { AUDIT_PATCH, GOOD_PATCH, REVIEW_PATCH, SCOPE_PATCH } from "../src/fixtures.js";
import { validatePatch } from "../src/schema.js";
import { verifyCandidate, warmUp, closeBrowser } from "./verifier.js";

const COMPONENT_FILE = new URL("../src/Combobox.jsx", import.meta.url);
const CANDIDATES_DIR = new URL("../src/candidates/", import.meta.url);

const PORT = 8787;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const LIVE_TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS ?? 12000);
const LIVE_ENABLED = process.env.LIVE_MODEL !== "off" && Boolean(process.env.GEMINI_API_KEY);

const client = LIVE_ENABLED ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

const PATCH_JSON_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string" },
    lineRange: { type: "array", items: { type: "integer" } },
    replacement: { type: "string" },
    ariaAttributesTouched: { type: "array", items: { type: "string" } },
  },
  required: ["path", "lineRange", "replacement", "ariaAttributesTouched"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You propose a single, minimal accessibility patch to a React component.

Return one JSON object:
- path: the file path you were given, exactly as given.
- lineRange: [start, end] line numbers (1-based) of the lines you replace. Keep it as small as possible.
- replacement: the new text for exactly those lines, keeping the original indentation.
- ariaAttributesTouched: every ARIA attribute (or "role") your replacement changes.

Rules for the replacement:
- Replace only JSX attribute lines. Every line of the replacement must be a single attribute, written as name={expression} or name="text".
- Expressions may use variables, literals, comparisons and ternaries only. No function calls, arrow functions or template strings.
- The attributes a patch may touch are: aria-expanded, aria-activedescendant, aria-controls, aria-haspopup, aria-autocomplete, aria-live, aria-hidden, role.

Fix only the reported issue. Do not refactor, rename, or touch unrelated code.`;

function numbered(source) {
  return source
    .split("\n")
    .map((line, index) => `${String(index + 1).padStart(3)} | ${line}`)
    .join("\n");
}

function buildUserMessage(feedback) {
  const source = readFileSync(COMPONENT_FILE, "utf8");
  const request = `File: src/Combobox.jsx

Reported issue: when the combobox list is visibly open, screen readers still announce it as "collapsed". aria-expanded does not follow the component's open state.

${numbered(source)}`;
  if (!feedback) return request;

  const check = feedback.stage === "schema" ? "the schema gate" : "the accessibility tree check";
  return `${request}

A previous patch for this issue was rejected by ${check}.

Rejected patch:
${feedback.patchText}

Reason: ${feedback.reason}

Propose a corrected patch.`;
}

async function streamLivePatch(onChunk, signal, feedback) {
  const stream = await client.models.generateContentStream({
    model: MODEL,
    contents: buildUserMessage(feedback),
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseJsonSchema: PATCH_JSON_SCHEMA,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      maxOutputTokens: 4000,
      abortSignal: signal,
    },
  });

  let text = "";
  let finishReason;
  for await (const chunk of stream) {
    if (signal.aborted) throw new Error("aborted");
    finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
    if (chunk.text) {
      text += chunk.text;
      onChunk(text);
    }
  }

  if (finishReason && finishReason !== FinishReason.STOP) {
    throw new Error(`model stopped early (${finishReason})`);
  }
  return { payload: JSON.parse(text), model: MODEL };
}

function shortError(error) {
  const text = String(error?.message ?? error);
  const inner = text.match(/\\?"message\\?":\s*\\?"([^"\\]+)/g)?.pop();
  const message = inner ? inner.replace(/^.*"\s*:\s*\\?"/, "") : text;
  return message.length > 120 ? `${message.slice(0, 117)}...` : message;
}

function send(socket, message) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function sendFixture(socket, payload, fallbackReason, source = "fixture") {
  send(socket, { type: "patch", payload, source, fallbackReason });
}

function readFeedback(feedback) {
  if (!feedback || !["schema", "verify"].includes(feedback.stage)) return null;
  return {
    stage: feedback.stage,
    reason: String(feedback.reason ?? "").slice(0, 500),
    patchText: JSON.stringify(feedback.patch ?? null, null, 2).slice(0, 2000),
  };
}

const activeRequests = new Map();

async function handleLive(socket, feedback) {
  if (!LIVE_ENABLED) {
    const reason =
      process.env.LIVE_MODEL === "off" ? "live model turned off (LIVE_MODEL=off)" : "live model disabled (no GEMINI_API_KEY)";
    sendFixture(socket, GOOD_PATCH, reason);
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), LIVE_TIMEOUT_MS);
  const started = Date.now();
  let streamed = false;
  activeRequests.set(socket, controller);

  try {
    const { payload, model } = await streamLivePatch(
      (text) => {
        streamed = true;
        send(socket, { type: "patch-chunk", text, model: MODEL });
      },
      controller.signal,
      feedback
    );
    const kind = feedback ? `retry after ${feedback.stage} rejection` : "patch";
    console.log(`[sidecar] live ${kind} from ${model} in ${Date.now() - started} ms`);
    send(socket, { type: "patch", payload, source: "model", model });
  } catch (error) {
    // The browser rejected a field mid-stream, so there is nothing to fall back to.
    if (controller.signal.reason === "cancelled") {
      console.log(`[sidecar] model call cancelled by the browser after ${Date.now() - started} ms`);
      return;
    }
    const reason =
      controller.signal.reason === "timeout"
        ? `live model took longer than ${LIVE_TIMEOUT_MS} ms`
        : `live model failed: ${shortError(error)}`;
    console.error(`[sidecar] ${reason} -- falling back to the recorded patch`);
    if (!controller.signal.aborted) console.error(error);
    // Partial model output is already on screen; the browser discards it.
    if (streamed) send(socket, { type: "patch-reset" });
    sendFixture(socket, GOOD_PATCH, reason);
  } finally {
    clearTimeout(timer);
    if (activeRequests.get(socket) === controller) activeRequests.delete(socket);
  }
}

function writeCandidateFile(source) {
  const id = randomBytes(4).toString("hex");
  writeFileSync(new URL(`Combobox.${id}.jsx`, CANDIDATES_DIR), source);
  return id;
}

// Patches a fresh copy of Combobox.jsx, the only file in scope. The original is never written.
function writeCandidate(patch) {
  const lines = readFileSync(COMPONENT_FILE, "utf8").split("\n");
  const [start, end] = patch.lineRange;
  if (end > lines.length) {
    throw new Error(`lineRange ${start}-${end} is outside the file (${lines.length} lines)`);
  }
  const before = lines.slice(start - 1, end);
  const after = patch.replacement.split("\n");
  lines.splice(start - 1, end - start + 1, ...after);

  const id = writeCandidateFile(lines.join("\n"));
  return { id, diff: { start, end, before, after } };
}

// One throwaway check, so Chrome and Vite's first compile are warm before the first real patch.
async function warmUpVerifier() {
  await warmUp();
  const id = writeCandidateFile(readFileSync(COMPONENT_FILE, "utf8"));
  const started = Date.now();
  await verifyCandidate(id);
  return Date.now() - started;
}

async function handleVerify(socket, requestId, patch) {
  const respond = (result) => send(socket, { type: "verify-result", requestId, ...result });

  // Never trust the browser's word that the patch passed the schema.
  const check = validatePatch(patch);
  if (!check.success) {
    respond({ passed: false, steps: [], reason: "the patch does not pass the schema" });
    return;
  }

  let candidate;
  try {
    candidate = writeCandidate(check.data);
  } catch (error) {
    respond({ passed: false, steps: [], reason: error.message });
    return;
  }

  const started = Date.now();
  try {
    const result = await verifyCandidate(candidate.id);
    console.log(
      `[sidecar] verified candidate ${candidate.id} in ${Date.now() - started} ms: ${result.passed ? "PASS" : "FAIL"}`
    );
    respond({ ...result, candidateId: candidate.id, diff: candidate.diff });
  } catch (error) {
    console.error(`[sidecar] could not verify candidate ${candidate.id}:`, error);
    respond({
      passed: false,
      steps: [],
      candidateId: candidate.id,
      diff: candidate.diff,
      reason: `could not run the check: ${shortError(error)}`,
    });
  }
}

rmSync(CANDIDATES_DIR, { recursive: true, force: true });
mkdirSync(CANDIDATES_DIR, { recursive: true });

const wss = new WebSocketServer({ port: PORT });

wss.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`[sidecar] port ${PORT} is already in use -- a sidecar is probably already running in another terminal.`);
    process.exit(1);
  }
  throw error;
});

wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === "verify-patch") {
      handleVerify(socket, message.requestId, message.patch);
      return;
    }
    if (message.type === "cancel-patch") return activeRequests.get(socket)?.abort("cancelled");
    if (message.type !== "request-patch") return;
    if (message.scenario === "review") sendFixture(socket, REVIEW_PATCH, undefined, "recreated");
    if (message.scenario === "scope") sendFixture(socket, SCOPE_PATCH, undefined, "recreated");
    if (message.scenario === "audit") sendFixture(socket, AUDIT_PATCH, undefined, "recreated");
    if (message.scenario === "good") handleLive(socket, null);
    if (message.scenario === "retry") handleLive(socket, readFeedback(message.feedback));
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await closeBrowser().catch(() => {});
    process.exit(0);
  });
}

console.log(`[sidecar] listening on ws://localhost:${PORT}`);
console.log(
  LIVE_ENABLED
    ? `[sidecar] good patch: live model ${MODEL} (falls back to recorded patch after ${LIVE_TIMEOUT_MS} ms)`
    : "[sidecar] good patch: recorded fixture (set GEMINI_API_KEY in .env to use the live model)"
);
warmUpVerifier()
  .then((ms) => console.log(`[sidecar] verifier ready (headless Chrome, warm-up check took ${ms} ms)`))
  .catch((error) =>
    console.error(
      `[sidecar] verifier warm-up failed: ${shortError(error)}\n` +
        "[sidecar] Is `npm run dev` running on localhost:5173? Checks will still be tried when a patch arrives."
    )
  );
