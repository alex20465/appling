import { cpSync, existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import { unified } from "@astrojs/markdown-remark";
import { remarkAlert } from "remark-github-blockquote-alert";
import { remarkDocs, applingLanguage, applingTheme } from "./src/markdown.ts";

const demo = fileURLToPath(new URL("../ide/dist/demo/", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ttf": "font/ttf" };

// The browser only IDE demo built by @appling/ide, at /ide/: served by astro dev, copied into the build
const ideDemo = {
  name: "ide-demo",
  hooks: {
    "astro:server:setup": ({ server }) => {
      server.middlewares.use("/ide", (request, response, next) => {
        const file = join(demo, request.url.split("?")[0].replace(/\/$/, "/index.html"));
        if (!file.startsWith(demo) || !existsSync(file)) return next();
        response.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream");
        response.end(readFileSync(file));
      });
    },
    "astro:build:done": ({ dir }) => cpSync(demo, fileURLToPath(new URL("ide/", dir)), { recursive: true }),
  },
};

export default defineConfig({
  integrations: [ideDemo],
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
