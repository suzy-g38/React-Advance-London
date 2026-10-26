import { startTransition } from "react";
import { validateField, validatePatch } from "./schema.js";
import { loadCandidate } from "./candidates.js";
import { completedFields } from "./streamingJson.js";

// Replays a non-model patch through the same streaming path as live model output.
export function streamPatchJSON(jsonString, chunkSize = 12, delayMs = 40) {
  let offset = 0;
  return new ReadableStream({
    async pull(controller) {
      if (offset >= jsonString.length) {
        controller.close();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const chunk = jsonString.slice(offset, offset + chunkSize);
      offset += chunkSize;
      controller.enqueue(chunk);
    },
  });
}

// Discards everything read so far: the model failed partway and a fallback follows.
export const RESET = Symbol("reset");

// Checks each field the moment it has fully arrived; the first failure cancels the stream.
export async function readAndValidateStream(stream, { onText, onField, onReset } = {}) {
  const reader = stream.getReader();
  const checked = new Set();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value === RESET) {
      text = "";
      checked.clear();
      onReset?.();
      continue;
    }
    text += value;
    onText?.(text);
    const fields = completedFields(text);
    for (const [name, fieldValue] of Object.entries(fields)) {
      if (checked.has(name)) continue;
      checked.add(name);
      const result = validateField(name, fieldValue);
      onField?.(name, result);
      if (!result.success) {
        await reader.cancel(`${name} failed the schema`);
        return { complete: false, field: name, reason: `${name}: ${result.reason}`, partial: fields };
      }
    }
  }
  return { complete: true, patch: JSON.parse(text) };
}

// postTask decides when the update starts; startTransition keeps the render interruptible.
function scheduleLowPriority(fn) {
  if (typeof scheduler !== "undefined" && typeof scheduler.postTask === "function") {
    return scheduler.postTask(fn, { priority: "background" });
  }
  return new Promise((resolve) => {
    setTimeout(() => resolve(fn()), 0);
  });
}

// Schema gate, then the accessibility tree check. Only a patch that passes both is applied.
export async function applyPatch(raw, { verify, onStage, onApply }) {
  const result = validatePatch(raw);

  if (!result.success) {
    return {
      applied: false,
      stage: "schema",
      reason: result.error.issues.map((issue) => issue.message).join("; "),
    };
  }

  onStage?.("verifying");
  const verification = await verify(result.data);
  if (!verification.passed) {
    return { applied: false, stage: "verify", reason: verification.reason, verification };
  }

  const { Combobox } = await loadCandidate(verification.candidateId);
  await scheduleLowPriority(() => {
    startTransition(() => onApply({ id: verification.candidateId, Component: Combobox }));
  });

  return { applied: true, stage: "applied", patch: result.data, verification };
}
