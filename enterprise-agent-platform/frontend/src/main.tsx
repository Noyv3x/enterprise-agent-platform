import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { startEnterpriseApp } from "./legacy-app.js";
import "./styles.css";

function EnterpriseAppRuntime() {
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    startEnterpriseApp();
  }, []);

  return null;
}

const root = document.getElementById("react-root");
if (!root) {
  throw new Error("Missing #react-root mount point");
}

createRoot(root).render(<EnterpriseAppRuntime />);
