import path from "node:path";
import { visit } from "unist-util-visit";
import type { Code, Link, Root } from "mdast";
import type { VFile } from "vfile";
import { buildSources, errorsOf, type Model } from "@appling/lang";
import monarch from "@appling/lang/monarch";
import { buildGraph, type Graph } from "@appling/model";
import { GITHUB_URL } from "./links";

// Layer colors of the landing's layer stack (Layers.astro), cross cutting as a plain node
const LAYERS = {
  domain: { label: "L1 Domain", fill: "#3d2510", ink: "#f7f2ea" },
  behavior: { label: "L2 Behavior", fill: "#6b3f12", ink: "#f7f2ea" },
  application: { label: "L3 Application", fill: "#a85f17", ink: "#f7f2ea" },
  interface: { label: "L4 Interfaces", fill: "#d98a1c", ink: "#0c0a08" },
  experience: { label: "L5 Experience", fill: "#f2b632", ink: "#0c0a08" },
  cross: { label: "Cross cutting", fill: "#1b1712", ink: "#f7f2ea" },
};

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Mermaid flowchart of the declarations in a graph, grouped by module; member references count for their declaration. */
function flowchart(graph: Graph): string {
  const decls = graph.nodes.filter((node) => node.level !== "in" && node.kind !== "Module");
  const ids = new Map(decls.map((node, i) => [node.qn, `n${i}`]));
  const owner = (qn: string) => decls.find((decl) => qn === decl.qn || qn.startsWith(`${decl.qn}.`))?.qn;

  const lines = ["flowchart TB"];
  for (const [i, module] of graph.nodes.filter((node) => node.kind === "Module").entries()) {
    lines.push(`  subgraph m${i}["${module.qn}"]`);
    for (const decl of decls.filter((node) => node.module === module.qn)) {
      const kind = decl.kind === "ValueType" ? "value" : decl.kind.toLowerCase();
      lines.push(`    ${ids.get(decl.qn)}["${decl.qn.slice(module.qn.length + 1)}<br/><small>${kind}</small>"]:::${decl.layer}`);
    }
    lines.push("  end");
  }

  const links = new Map<string, Set<string>>();
  for (const edge of graph.edges.filter((edge) => edge.kind !== "contains")) {
    const from = owner(edge.from);
    const to = owner(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${ids.get(from)} --> ${ids.get(to)}`;
    links.set(key, (links.get(key) ?? new Set()).add(edge.kind));
  }
  for (const [link, kinds] of links) lines.push(`  ${link.replace("-->", `-->|"${[...kinds].join(", ")}"|`)}`);

  for (const [layer, { fill, ink }] of Object.entries(LAYERS)) {
    lines.push(`  classDef ${layer} fill:${fill},stroke:${layer === "cross" ? "#7a6e5e" : fill},color:${ink}`);
  }
  return lines.join("\n");
}

function graphFigure(graph: Graph): string {
  const used = Object.entries(LAYERS).filter(([layer]) => graph.nodes.some((node) => node.layer === layer && node.kind !== "Module"));
  const legend = used.map(([, { label, fill }]) => `<span class="layer-chip" style="--chip: ${fill}">${label}</span>`).join("");
  return `<figure class="model-graph"><pre class="mermaid">${escape(flowchart(graph))}</pre><figcaption><span>The semantic graph Appling builds from this model</span>${legend}</figcaption></figure>`;
}

/**
 * Docs markdown on top of GitHub flavored markdown:
 * - `appling check` and `appling graph` fences must validate, or the build fails; `graph` also draws the model graph
 * - `mermaid` fences render as diagrams in the browser
 * - relative links to .md files under docs/ point to their docs page, other relative links to the file on GitHub
 */
export function remarkDocs({ root }: { root: string }) {
  const repo = path.dirname(path.resolve(root));

  return async (tree: Root, file: VFile) => {
    const examples: Code[] = [];

    visit(tree, "code", (node, index, parent) => {
      if (node.lang === "mermaid") parent!.children[index!] = { type: "html", value: `<pre class="mermaid">${escape(node.value)}</pre>` };
      else if (node.lang === "appling" && /\b(check|graph)\b/.test(node.meta ?? "")) examples.push(node);
    });

    visit(tree, "link", (node: Link) => {
      if (/^([a-z]+:|\/|#)/i.test(node.url) || !file.path) return;
      const [target, hash = ""] = node.url.split("#");
      const absolute = path.resolve(path.dirname(file.path), target);
      const relative = path.relative(root, absolute);
      if (!relative.startsWith("..") && relative.endsWith(".md")) {
        const id = relative.replace(/\.md$/, "").toLowerCase();
        node.url = (id === "index" ? "/docs/" : `/docs/${id}/`) + (hash && `#${hash}`);
      } else {
        node.url = `${GITHUB_URL}/blob/main/${path.relative(repo, absolute)}${hash && `#${hash}`}`;
      }
    });

    for (const node of examples) {
      const workspace = await buildSources({ "file:///example.appling": node.value });
      const errors = errorsOf(workspace);
      if (errors.length) throw new Error(`${file.path}:${node.position?.start.line}: the Appling example has errors:\n${errors.join("\n")}`);
      if (!/\bgraph\b/.test(node.meta ?? "")) continue;
      const graph = buildGraph(
        workspace.documents.map((doc) => doc.parseResult.value as Model),
        workspace.services,
      );
      visit(tree, "code", (code, index, parent) => {
        if (code === node) parent!.children.splice(index! + 1, 0, { type: "html", value: graphFigure(graph) });
      });
    }
  };
}

const keywords = monarch.keywords as string[];
const types = keywords.filter((word) => /^[A-Z]/.test(word));

/** Shiki grammar for Appling, from the keyword list the language generates for Monaco. */
export const applingLanguage = {
  name: "appling",
  scopeName: "source.appling",
  patterns: [
    { name: "comment.line.double-slash.appling", match: "//.*$" },
    { name: "comment.block.appling", begin: "/\\*", end: "\\*/" },
    { name: "string.quoted.double.appling", match: '"(\\\\.|[^"\\\\])*"' },
    { name: "constant.numeric.appling", match: "\\b[0-9]+(\\.[0-9]+)?\\b" },
    { name: "support.type.appling", match: `\\b(${types.join("|")})\\b` },
    { name: "keyword.control.appling", match: `\\b(${keywords.filter((word) => !types.includes(word)).join("|")})\\b` },
    { name: "entity.name.type.appling", match: "\\b[A-Z][A-Za-z0-9_]*\\b" },
    { name: "keyword.operator.appling", match: "->|==|!=|<=|>=|&&|\\|\\||[-+*/%<>=!?]" },
  ],
};

/** Code colors from the design tokens, matching the landing's code samples. */
export const applingTheme = {
  name: "appling",
  type: "dark",
  colors: { "editor.background": "#14110d", "editor.foreground": "#d9d0c3" },
  tokenColors: [
    { scope: ["comment"], settings: { foreground: "#aaa092", fontStyle: "italic" } },
    { scope: ["keyword", "storage", "keyword.control"], settings: { foreground: "#a6dc5a" } },
    { scope: ["keyword.operator", "punctuation"], settings: { foreground: "#aaa092" } },
    { scope: ["string", "markup.inline.raw"], settings: { foreground: "#5cbf63" } },
    { scope: ["constant", "constant.numeric", "constant.language"], settings: { foreground: "#f2b632" } },
    { scope: ["entity.name", "support.type", "entity.name.type", "support.class", "entity.name.function", "support.function"], settings: { foreground: "#f7f2ea" } },
    { scope: ["variable.parameter", "variable.other.property", "support.type.property-name", "entity.other.attribute-name"], settings: { foreground: "#f7f2ea" } },
  ],
};
