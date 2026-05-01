import "@fontsource-variable/geist-mono";
import "@fontsource-variable/geist";
import "./styles.css";
import { render } from "solid-js/web";
import { App } from "./App";

const root = document.getElementById("app");
if (!root) {
  throw new Error("root element #app not found");
}
render(() => <App />, root);
