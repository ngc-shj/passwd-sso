import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initTheme } from "../lib/theme";
import "./styles.css";

initTheme().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App promptId={new URLSearchParams(location.search).get("id")} />
    </StrictMode>,
  );
});
