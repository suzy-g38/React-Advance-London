import { useEffect, useRef, useState } from "react";
import { Combobox } from "./Combobox.jsx";
import { FareSummary } from "./FareSummary.jsx";
import { streamPatchJSON, readAndValidateStream, applyPatch, RESET } from "./patchPipeline.js";

const SIDECAR_URL = "ws://localhost:8787";
const PATCH_TIMEOUT_MS = 20000;
const VERIFY_TIMEOUT_MS = 20000;

const MAX_RETRIES = 2;
const RETRY_PAUSE_MS = 1500;

const FIELDS = ["path", "lineRange", "replacement", "ariaAttributesTouched"];

export function App() {
  const [connection, setConnection] = useState("connecting");
  const [attempts, setAttempts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(null);
  const socketRef = useRef(null);
  const requestCounter = useRef(0);

  useEffect(() => {
    const socket = new WebSocket(SIDECAR_URL);
    socketRef.current = socket;
    socket.addEventListener("open", () => setConnection("open"));
    socket.addEventListener("close", () => setConnection("closed"));
    socket.addEventListener("error", () => setConnection("closed"));
    return () => socket.close();
  }, []);

  function requestVerification(patch) {
    const socket = socketRef.current;
    const requestId = ++requestCounter.current;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve({ passed: false, steps: [], reason: "the verifier did not answer in time" });
      }, VERIFY_TIMEOUT_MS);
      function onMessage(event) {
        const data = JSON.parse(event.data);
        if (data.type === "verify-result" && data.requestId === requestId) {
          cleanup();
          resolve(data);
        }
      }
      function cleanup() {
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
      }
      socket.addEventListener("message", onMessage);
      socket.send(JSON.stringify({ type: "verify-patch", requestId, patch }));
    });
  }

  function patchStream(request, onSource) {
    const socket = socketRef.current;
    let onMessage;
    let timer;
    let received = 0;
    let replay = null;
    let cancelled = false;
    const stop = () => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
    };

    return new ReadableStream({
      start(controller) {
        timer = setTimeout(() => {
          stop();
          controller.error(new Error("no answer from the sidecar"));
        }, PATCH_TIMEOUT_MS);

        onMessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "patch-chunk") {
            if (received === 0) onSource({ kind: "model", model: data.model });
            controller.enqueue(data.text.slice(received));
            received = data.text.length;
          }
          if (data.type === "patch-reset") {
            controller.enqueue(RESET);
            received = 0;
          }
          if (data.type !== "patch") return;

          stop();
          onSource({ kind: data.source, model: data.model, fallbackReason: data.fallbackReason });
          if (data.source === "model") {
            controller.close();
            return;
          }
          replay = streamPatchJSON(JSON.stringify(data.payload, null, 2)).getReader();
          (async () => {
            while (!cancelled) {
              const { value, done } = await replay.read();
              if (cancelled) return;
              if (done) {
                controller.close();
                return;
              }
              controller.enqueue(value);
            }
          })();
        };

        socket.addEventListener("message", onMessage);
        socket.send(JSON.stringify({ type: "request-patch", ...request }));
      },
      cancel() {
        cancelled = true;
        stop();
        replay?.cancel();
        socket.send(JSON.stringify({ type: "cancel-patch" }));
      },
    });
  }

  function updateAttempt(index, changes) {
    setAttempts((list) => list.map((attempt, i) => (i === index ? { ...attempt, ...changes } : attempt)));
  }

  function setField(index, name, check) {
    setAttempts((list) =>
      list.map((attempt, i) => (i === index ? { ...attempt, fields: { ...attempt.fields, [name]: check } } : attempt))
    );
  }

  async function runAttempt(index, request) {
    setAttempts((list) => [...list, { feedback: request.feedback, streamedText: "", fields: {} }]);
    let source = null;
    const stream = patchStream(request, (value) => {
      source = value;
      updateAttempt(index, { source: value });
    });

    let read;
    try {
      read = await readAndValidateStream(stream, {
        onText: (text) => updateAttempt(index, { streamedText: text }),
        onField: (name, check) => setField(index, name, check),
        onReset: () => updateAttempt(index, { streamedText: "", fields: {} }),
      });
    } catch (error) {
      const result = { applied: false, stage: "error", reason: error.message };
      updateAttempt(index, { result });
      return { result };
    }

    if (!read.complete) {
      const result = {
        applied: false,
        stage: "stream",
        field: read.field,
        reason: read.reason,
        modelStopped: source?.kind === "model",
      };
      updateAttempt(index, { result });
      return { patch: read.partial, result };
    }

    let result;
    try {
      result = await applyPatch(read.patch, {
        verify: requestVerification,
        onStage: (stage) => updateAttempt(index, { result: { applied: false, stage } }),
        onApply: setApplied,
      });
    } catch (error) {
      result = { applied: false, stage: "error", reason: error.message };
    }
    updateAttempt(index, { result });
    return { patch: read.patch, result };
  }

  async function runScenario(scenario) {
    if (connection !== "open" || busy) return;
    setBusy(true);
    setAttempts([]);

    let request = { scenario };
    for (let index = 0; index <= MAX_RETRIES; index++) {
      const { patch, result } = await runAttempt(index, request);
      if (result.applied || result.stage === "error" || index === MAX_RETRIES) break;

      updateAttempt(index, { retrying: true });
      await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
      const stage = result.stage === "verify" ? "verify" : "schema";
      request = { scenario: "retry", feedback: { stage, reason: result.reason, patch } };
    }
    setBusy(false);
  }

  function handleReset() {
    if (busy) return;
    setApplied(null);
    setAttempts([]);
  }

  const ActiveCombobox = applied?.Component ?? Combobox;
  const canSend = !busy && connection === "open";
  const latest = attempts.at(-1);
  const last = latest?.result;
  const announcement = latest?.result
    ? `Attempt ${attempts.length}: ${TITLES[latest.result.stage]}${latest.result.reason ? `. ${latest.result.reason}` : ""}`
    : busy
      ? "Working"
      : "";
  const gaveUp = !busy && attempts.length > MAX_RETRIES && last && !last.applied && last.stage !== "error";

  return (
    <main className="app">
      <p className="eyebrow">React Advanced London</p>
      <h1>Healing the Accessibility Tree</h1>
      <p role="status" className={`status ${connection === "open" ? "status--open" : ""}`}>
        sidecar: {connection} {connection !== "open" && "— run `npm run sidecar` in a second terminal"}
      </p>

      <section className="card">
        <div className="card-head">
          <h2>Booking widget</h2>
          <span className={`badge ${applied ? "badge--ok" : "badge--bug"}`}>
            {applied ? "✓ Patched · verified" : "● Original · has the bug"}
          </span>
        </div>
        <ActiveCombobox key={applied?.id ?? "original"} />
        <FareSummary fare={{ total: 148 }} />
      </section>

      <div className="controls" role="group" aria-label="Demo controls">
        <button className="btn btn--primary" onClick={() => runScenario("good")} aria-disabled={!canSend}>
          Ask the live model
        </button>
        <button className="btn" onClick={() => runScenario("review")} aria-disabled={!canSend}>
          Replay failure 1 (recreated)
        </button>
        <button className="btn" onClick={() => runScenario("scope")} aria-disabled={!canSend}>
          Replay failure 2 (recreated)
        </button>
        <button className="btn" onClick={() => runScenario("audit")} aria-disabled={!canSend}>
          Replay failure 3 (recreated)
        </button>
        <button className="btn btn--ghost" onClick={handleReset} aria-disabled={busy}>
          Reset demo
        </button>
      </div>

      {/* Always rendered: screen readers only announce changes inside an existing live region. */}
      <div role="status" className="sr-only">
        {announcement}
      </div>

      {attempts.map((attempt, index) => (
        <Attempt key={index} number={index + 1} attempt={attempt} latest={index === attempts.length - 1} />
      ))}
      {gaveUp && (
        <p className="gave-up">Gave up after {attempts.length} attempts. Nothing was applied.</p>
      )}
    </main>
  );
}

function SourceTag({ source }) {
  if (!source) return <p className="waiting">waiting for the model…</p>;
  if (source.kind === "model") return <span className="tag tag--live">Live model · {source.model}</span>;
  if (source.kind === "recreated") return <span className="tag tag--recreated">Recreated failure · hand-written</span>;
  return <span className="tag tag--recorded">Recorded run</span>;
}

function Attempt({ number, attempt, latest }) {
  const { feedback, streamedText, fields, source, result, retrying } = attempt;
  const ref = useRef(null);

  useEffect(() => {
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    ref.current?.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "nearest" });
  }, [result?.stage]);

  const stream = <pre className="stream">{streamedText || "waiting for the model…"}</pre>;

  return (
    <section ref={ref} className="attempt">
      <h2>
        Attempt {number}
        {feedback && ": retry with the rejection fed back"}
      </h2>
      {feedback && (
        <p className="sent-back">
          Sent back to the model: <em>{feedback.reason}</em>
        </p>
      )}
      <div>
        <SourceTag source={source} />
      </div>
      {latest ? (
        stream
      ) : (
        <details>
          <summary>Streamed patch</summary>
          {stream}
        </details>
      )}
      <FieldChecks fields={fields} />
      {result && <ResultPanel result={result} />}
      {retrying && <p className="retry-note">↓ Rejection reason sent back to the model</p>}
    </section>
  );
}

function FieldChecks({ fields }) {
  return (
    <div className="fields">
      <h3>Schema, field by field, as it streams in</h3>
      <ul>
        {FIELDS.map((name) => {
          const check = fields[name];
          const state = !check ? "pending" : check.success ? "ok" : "bad";
          return (
            <li key={name} className={`field--${state}`}>
              <span aria-hidden="true">{!check ? "·" : check.success ? "✓" : "✗"}</span>
              <span className="sr-only">{!check ? "pending: " : check.success ? "passed: " : "failed: "}</span> {name}
              {check && !check.success && `: ${check.reason}`}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const TITLES = {
  verifying: "Checking the live accessibility tree…",
  applied: "Applied",
  stream: "Rejected mid-stream by the schema gate",
  schema: "Rejected by the schema gate",
  verify: "Not applied: failed the accessibility tree check",
  error: "No patch",
};

function ResultPanel({ result }) {
  const { stage, verification } = result;
  const tone = stage === "verifying" ? "pending" : result.applied ? "ok" : "bad";

  return (
    <section className={`result result--${tone}`}>
      <h3>{TITLES[stage]}</h3>

      {stage !== "error" && (
        <p>
          <strong>1. Schema gate:</strong>{" "}
          {stage === "schema" || stage === "stream" ? (
            <>
              ✗ rejected. <em>{result.reason}</em>
            </>
          ) : (
            "✓ passed"
          )}
        </p>
      )}

      {stage === "stream" && (
        <p>
          {result.modelStopped
            ? "Stream cancelled and the model call stopped: the rest of the patch was never generated."
            : "Stream cancelled: the rest of the patch was never read."}
        </p>
      )}
      {(stage === "schema" || stage === "stream") && <p>Nothing was applied, and the patch never ran.</p>}

      {(stage === "verifying" || verification) && (
        <div>
          <p>
            <strong>2. Live accessibility tree</strong> (headless Chrome, patched copy):
            {stage === "verifying" && " checking…"}
          </p>
          {verification?.diff && <Diff diff={verification.diff} />}
          {verification?.steps?.length > 0 && <StepsTable steps={verification.steps} />}
        </div>
      )}

      {stage === "verify" && (
        <p>
          Not applied: <em>{verification.reason}</em>
        </p>
      )}
      {stage === "applied" && (
        <p>
          Applied at background priority, as a React transition. The page is now running the patched
          component.
        </p>
      )}
      {stage === "error" && <p>{result.reason}</p>}
    </section>
  );
}

function Diff({ diff }) {
  const lines = diff.start === diff.end ? `line ${diff.start}` : `lines ${diff.start}–${diff.end}`;
  return (
    <pre>
      {`Combobox.jsx, ${lines}\n`}
      {diff.before.map((line) => `- ${line.trim()}\n`).join("")}
      {diff.after.map((line) => `+ ${line.trim()}\n`).join("")}
    </pre>
  );
}

function StepsTable({ steps }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Combobox is</th>
          <th>Tree should say</th>
          <th>Tree says</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((step) => (
          <tr key={step.state}>
            <td>{step.state}</td>
            <td>expanded: {String(step.expected)}</td>
            <td>expanded: {String(step.actual)}</td>
            <td className={step.ok ? "ok" : "bad"}>
              <span aria-hidden="true">{step.ok ? "✓" : "✗"}</span>
              <span className="sr-only">{step.ok ? "passed" : "failed"}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
