import { render } from "solid-js/web";
import "@picocss/pico/css/pico.min.css";
import { App } from "./App";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("The application root is missing.");
}

render(() => <App />, root);
