import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { StoryCanvas } from "@appling/viz/canvas";
import type { ModelView } from "@appling/viz/views";
import { GraphIndex } from "@appling/viz/views";
import type { Graph } from "@appling/model";
import "@appling/viz/canvas.css";

let examples: Promise<Graph> | undefined;

/** Draws the story of a `Story.astro` element with the real canvas: on its own graph, else on the examples. */
export async function mount(element: HTMLElement) {
  const own = element.querySelector("script")?.textContent;
  const graph = own ? (JSON.parse(own) as Graph) : await (examples ??= fetch("/examples.graph.json").then((r) => r.json()));
  const { view, element: qn, name } = element.dataset;
  createRoot(element).render(createElement(StoryCanvas, { story: { view: view as ModelView, element: qn! }, index: new GraphIndex(graph), name: name! }));
}
