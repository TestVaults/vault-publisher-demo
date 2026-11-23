import { greet } from "./dep.js";

function mark(id, ok, text) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = ok ? "ok" : "bad";
  document.body.dataset[id.replace("-status", "")] = ok ? "loaded" : "failed";
}

const img = new Image();
img.width = 160;
img.alt = "placeholder";
img.onload = () => mark("img-status", true, "loaded");
img.onerror = () => mark("img-status", false, "failed");
img.src = "img/" + ["placeholder", "photo"].join("-") + ".png";
setTimeout(() => document.getElementById("photo").appendChild(img), 200);

fetch("data/" + "people.json")
  .then((r) => r.json())
  .then((j) => mark("data-status", true, j.message))
  .catch(() => mark("data-status", false, "failed"));

import("./chunk-" + "a.js")
  .then((m) => mark("chunk-status", true, greet() + ", " + m.later()))
  .catch(() => mark("chunk-status", false, "failed"));
