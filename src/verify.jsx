// Loaded by the verifier: renders a single patched copy of the combobox.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loadCandidate } from "./candidates.js";

const root = createRoot(document.getElementById("root"));
const id = new URLSearchParams(location.search).get("candidate");

try {
  const { Combobox } = await loadCandidate(id);
  root.render(
    <StrictMode>
      <Combobox />
    </StrictMode>
  );
} catch (error) {
  // Lets the verifier stop waiting when a patch breaks the component.
  root.render(<p data-verify-error>{String(error.message)}</p>);
}
