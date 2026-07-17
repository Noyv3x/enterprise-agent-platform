import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./design-system.css";
import "./components/chat/chat.css";
import "./components/admin/admin.css";
import "./styles/workspace-modern.css";
import "./components/preview/preview.css";
import "./components/scheduled-tasks/scheduled-tasks.css";

const root = document.getElementById("react-root");
if (!root) {
  throw new Error("Missing #react-root mount point");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
