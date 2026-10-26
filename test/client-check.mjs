// Usage: npm run test:sidecar -- good | review | scope | audit | retry

import { WebSocket } from "ws";
import { validatePatch } from "../src/schema.js";

const mode = process.argv[2] || "good";
const socket = new WebSocket("ws://localhost:8787");
const messages = [];
let waiting = null;

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type === "patch-chunk") return;
  messages.push(message);
  waiting?.();
});

function next(type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TIMEOUT waiting for ${type}`)), 30000);
    const check = () => {
      const index = messages.findIndex((m) => m.type === type);
      if (index === -1) return;
      clearTimeout(timer);
      waiting = null;
      resolve(messages.splice(index, 1)[0]);
    };
    waiting = check;
    check();
  });
}

async function requestPatch(request) {
  const started = Date.now();
  socket.send(JSON.stringify({ type: "request-patch", ...request }));
  const msg = await next("patch");
  const source =
    msg.source === "model" ? `live model (${msg.model})` : msg.source === "recreated" ? "recreated failure" : "recorded patch";
  console.log(`  source: ${source}${msg.fallbackReason ? ` -- ${msg.fallbackReason}` : ""} (${Date.now() - started} ms)`);
  console.log("  payload:", JSON.stringify(msg.payload));
  const result = validatePatch(msg.payload);
  const reason = result.success ? undefined : result.error.issues.map((i) => i.message).join("; ");
  console.log(`  schema result: ${result.success ? "ACCEPTED" : `REJECTED -- ${reason}`}`);
  return { patch: msg.payload, accepted: result.success, reason };
}

async function verify(patch) {
  socket.send(JSON.stringify({ type: "verify-patch", requestId: 1, patch }));
  const result = await next("verify-result");
  console.log(`  tree check: ${result.passed ? "PASSED" : `FAILED -- ${result.reason}`}`);
  return result.passed;
}

socket.on("open", async () => {
  try {
    if (mode !== "retry") {
      console.log(`${mode} patch:`);
      await requestPatch({ scenario: mode });
    } else {
      console.log("attempt 1 (failure 2, recreated):");
      const first = await requestPatch({ scenario: "scope" });
      if (first.accepted) throw new Error("the recreated failure 2 was not rejected");
      console.log("attempt 2 (retry with the rejection fed back):");
      const second = await requestPatch({
        scenario: "retry",
        feedback: { stage: "schema", reason: first.reason, patch: first.patch },
      });
      if (second.accepted) await verify(second.patch);
    }
    process.exit(0);
  } catch (error) {
    console.error("client:", error.message);
    process.exit(1);
  }
});

socket.on("error", (err) => {
  console.error("client: socket error", err.message);
  process.exit(1);
});
