import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // A broken candidate is reported by the verifier; don't also show Vite's error overlay.
    hmr: { overlay: false },
    // Candidates are imported on demand, never hot-reloaded.
    watch: { ignored: ["**/src/candidates/**"] },
  },
});
