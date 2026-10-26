# Healing the Accessibility Tree

Demo code for the React Advanced London 2026 talk *Healing the Accessibility Tree: Streaming Live ARIA Fixes with AI*.

A combobox has a bug that every static tool misses. An AI model is asked to fix it, and nothing it proposes is trusted: each patch streams in through a typed schema, is verified against Chrome's computed accessibility tree, and is applied only if it passes both.

## The bug

`src/Combobox.jsx` keeps a copy of its open state:

```js
const [open, setOpen] = useState(false);
const [expanded] = useState(open); // copied once, on the first render
// ...
aria-expanded={expanded}
```

`useState` only reads its argument on the first render, so `expanded` stays `false` while `open` changes. The list opens; screen readers are told it is collapsed.

Static tools pass it, because `false` is a valid value:

- `npm run lint`: `eslint-plugin-jsx-a11y` (recommended config) exits clean.
- `npm run test:axe`: axe-core reports 0 violations on the page with the combobox **open**.

## How a patch is checked and applied

```
model ──stream──► schema gate ──► accessibility tree check ──► apply (low priority)
                      │                     │
                      └── rejected ─────────┴──► reason fed back to the model, retry
```

1. **Schema gate** (`src/schema.js`). The patch arrives as a `ReadableStream`, and each field is validated the moment its value has fully arrived (`src/streamingJson.js`, `readAndValidateStream` in `src/patchPipeline.js`). The first failing field cancels the stream and stops the model call. The schema allows:
   - a component file directly under `src/`
   - at most 5 lines
   - replacement lines that are single ARIA attributes, with no function calls, arrows or template strings
   - only attributes on the allowlist, each one declared
2. **Accessibility tree check** (`server/verifier.js`). The sidecar re-validates the patch, applies it to a copy of `Combobox.jsx` in `src/candidates/` (the original is never written), and loads the copy in headless Chrome. It then drives the combobox: closed, open, closed again, and closed by picking an option. After each step it reads the computed accessibility tree over the DevTools Protocol (`Accessibility.getFullAXTree`). The patch passes only if `expanded` follows the real state at every step.
3. **Apply** (`src/patchPipeline.js`). The page switches to the verified copy through `scheduler.postTask` at `background` priority, inside `startTransition`, so an agent's fix never pre-empts a user's interaction. Browsers without `postTask` fall back to `setTimeout`.
4. **Retry.** A patch rejected by either gate is sent back to the model together with the exact reason. At most two retries; after that, nothing is applied.

The schema limits *what* can change; the tree check decides whether the change is *right*. Each catches failures the other cannot.

## The sidecar

`server/sidecar.js` is a separate Node process on `ws://localhost:8787`. The model call, retries, patched copies and the headless Chrome all run there, and the page only exchanges small messages with it. The API key never reaches the browser.

The model is Gemini (`gemini-3.8-flash` by default), called with structured output. Structured output fixes only the *shape* of the answer; whether a patch is used is decided by the two gates.

## Running it

Requires Node 22.9+ and Google Chrome (the verifier drives your installed Chrome through `playwright-core`).

```bash
npm install
cp .env.example .env   # add your GEMINI_API_KEY
```

Two terminals:

```bash
npm run dev       # http://localhost:5173
npm run sidecar   # wait for "verifier ready"
```

### Demo controls

| Button | What it sends | Where it is stopped |
|---|---|---|
| **Ask the live model** | a patch from the live model | passes both gates and is applied |
| **Replay failure 1 (recreated)** | adds `aria-live="polite"`, never touches `aria-expanded` | tree check, then retried |
| **Replay failure 2 (recreated)** | adds its own `expanded` state, updated only on input click | schema gate (mid-stream), then retried |
| **Replay failure 3 (recreated)** | hard-codes `aria-expanded="true"` | tree check, then retried |

The three failures are hand-written recreations of failure modes met while building this, and are labelled as such on screen. Retries always go to the live model. If the model is unavailable or takes longer than 12 s, the sidecar uses a recorded patch, labelled **Recorded run**, which goes through the same checks.

## Tests

| Command | Needs | Checks |
|---|---|---|
| `npm run lint` | | `jsx-a11y` passes the buggy component |
| `npm run test:pipeline` | | every schema rule, including path traversal and code injection; per-field streaming validation |
| `npm run test:axe` | dev server | axe-core: 0 violations with the combobox open |
| `npm run test:verify` | dev server, sidecar | the tree check passes the fix and fails each recreated failure, broken markup and non-compiling patches |
| `npm run test:sidecar -- retry` | dev server, sidecar | rejection, retry with feedback, tree check, end to end |

## Scope

- One component and one behaviour: the combobox's `expanded` state. The allowlist covers what modal focus traps and live regions need; their tree checks are not implemented yet.
- Patches are applied to copies loaded on demand, not written over the source file.
- Not a general accessibility solver.

## Files

```
server/sidecar.js      WebSocket sidecar: model calls, retries, patched copies, verification
server/verifier.js     accessibility tree check (headless Chrome, DevTools Protocol)
src/schema.js          PatchSchema and the ARIA allowlist
src/patchPipeline.js   streaming validation, schema gate → tree check → low-priority apply
src/streamingJson.js   reads completed fields from JSON that is still streaming in
src/fixtures.js        recreated failures and the recorded fallback
src/Combobox.jsx       the component with the bug
src/FareSummary.jsx    the static half of the booking widget
src/App.jsx            demo UI
src/verify.jsx         page the verifier loads (verify.html)
test/                  the checks above
```
