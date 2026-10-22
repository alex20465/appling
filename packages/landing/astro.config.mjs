import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import { unified } from "@astrojs/markdown-remark";
import { remarkAlert } from "remark-github-blockquote-alert";
import { remarkDocs, applingLanguage, applingTheme } from "./src/markdown.ts";

export default defineConfig({
  site: "https://appling.tools",
  markdown: {
    processor: unified({
      remarkPlugins: [remarkAlert, [remarkDocs, { root: fileURLToPath(new URL("../../docs/", import.meta.url)) }]],
    }),
    shikiConfig: {
      theme: applingTheme,
      langs: [applingLanguage],
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
