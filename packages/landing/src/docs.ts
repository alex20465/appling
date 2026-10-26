// The docs sidebar in reading order. Every page in the repository's docs/ folder must be listed here, by its id:
// the path under docs/ without .md, lowercased.
export const SECTIONS = [
  { label: "Start here", pages: ["index", "getting-started/installation", "getting-started/first-model", "getting-started/existing-project", "getting-started/workspace"] },
  {
    label: "Language",
    pages: [
      "language/overview",
      "language/modules",
      "language/relevance",
      "language/access",
      "language/domain",
      "language/behavior",
      "language/application",
      "language/interfaces",
      "language/experience",
      "language/expressions",
      "language/migrations",
      "language/validation",
    ],
  },
  { label: "Tools", pages: ["tools/cli", "tools/ide", "tools/editors", "tools/ai", "tools/simulator", "tools/references"] },
  { label: "Code generation", pages: ["codegen/overview", "codegen/registry", "codegen/migrations", "codegen/sync", "codegen/django", "codegen/ash", "codegen/go", "codegen/rust", "codegen/extensions"] },
  { label: "Reference", pages: ["reference/configuration", "reference/graph", "reference/edit-operations", "reference/api"] },
  { label: "Contributing", pages: ["contributing/development", "contributing/architecture", "contributing/documentation"] },
  { label: "Project", pages: ["concept", "roadmap"] },
];

export const PAGES = SECTIONS.flatMap((section) => section.pages);

export function docHref(id: string): string {
  return id === "index" ? "/docs/" : `/docs/${id}/`;
}

export function sectionOf(id: string): string {
  return SECTIONS.find((section) => section.pages.includes(id))!.label;
}
