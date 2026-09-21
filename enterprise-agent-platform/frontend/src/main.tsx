import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./components/ui/beautiful/application.css";

const root = document.getElementById("react-root");
if (!root) {
  throw new Error("Missing #react-root mount point");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
