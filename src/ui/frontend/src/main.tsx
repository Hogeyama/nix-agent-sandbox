import { render } from "preact";
import { App } from "./App.tsx";

const root = document.getElementById("app");
if (!root) {
  throw new Error('Root element "#app" not found');
}
render(<App />, root);
