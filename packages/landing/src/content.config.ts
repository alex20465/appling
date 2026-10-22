import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

// The documentation lives in the repository's docs/ folder, so it reads on GitHub as well
const docs = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "../../docs", generateId: ({ entry }) => entry.replace(/\.md$/, "").toLowerCase() }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
  }),
});

export const collections = { docs };
