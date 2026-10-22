---
name: landing-site
description: Astro 7 and Tailwind 4 specifics of the Appling landing site (packages/landing), its animation, mascot, consent and deploy setup. Use when adding or changing a page, component, style token, animation or script on the landing site, or when a page or asset removal must go live.
metadata:
  anchors:
    - name: astro
      version: 7.3.8
      researched: 2026-10-23
    - name: tailwindcss
      version: 4.3.3
      researched: 2026-10-23
---

# Landing site

What an Astro 4 and Tailwind 3 engineer gets wrong here.

## Tailwind 4 CSS first setup

Tailwind loads through `@tailwindcss/vite` in `astro.config.mjs`. `global.css` holds `@import "tailwindcss"` and the tokens under `@theme` (`--color-*`, `--font-*`, `--radius-*`), which generate utilities such as `bg-surface` and `text-ink`. Source: https://tailwindcss.com/docs/upgrade-guide, https://docs.astro.build/en/guides/styling/#tailwind

`@layer components` is a native cascade layer; its classes no longer take variants. A class that needs `hover:` or `md:` is declared with `@utility` (`eyebrow`, `hazard`, `text-h1`, `text-code`). The animation and menu classes in `@layer components` are plain CSS. Source: `src/styles/global.css`, upgrade guide.

Class syntax: CSS variables as `w-(--w)` (not `w-[--w]`), stacked variants apply left to right, important at the end (`flex!`), container queries (`@container`, `@min-[276px]:`) are built in, `hover:` applies only under `@media (hover: hover)`, and border and ring colors default to `currentColor`, so name a color (`border-line`). Source: upgrade guide.

## Astro 7

`compressHTML` defaults to `'jsx'`: line breaks around elements are removed, so a space between inline elements on separate lines disappears; write `{" "}`. Source: `astro/dist/types/public/config.d.ts`, https://docs.astro.build/en/guides/upgrade-to/v7/

Since Astro 5, processed `<script>` tags are not hoisted or bundled together; they render where declared and run only when their component is used. `Astro.glob` (use `import.meta.glob`), `<ViewTransitions />` (use `<ClientRouter />`) and legacy content collections are gone. Source: https://docs.astro.build/en/guides/upgrade-to/v5/

## Animation without a framework

`motion` is declared in `package.json` but imported nowhere, and there is no UI framework integration (no `client:` directives). Animation is CSS keyframes in `global.css` plus hand written `requestAnimationFrame` scripts (Mascots scroll and eye tracking, Layers hover). The mobile menu uses the native Popover API with `@starting-style`. Source: `src/components/Mascots.astro`, `Header.astro`, `global.css`.

## Mascots

`bots.ts` holds each artwork's pixel size and eye positions `[x, y, r]`. The painted eyes were removed from the webp files; `Bot.astro` draws them as an SVG overlay so they follow the cursor or focus and wink. A new bot needs `public/appling-bot-<name>.webp` and an entry in `BOTS`. Source: `src/bots.ts`, `src/components/Bot.astro`.

## Consent and metadata

`Consent.astro` injects the Umami script only after consent, stored under localStorage `appling-consent`; withdrawing reloads the page, and any `[data-consent-open]` element reopens the dialog. Canonical, `og:url` and `og:image` derive from `site: "https://appling.tools"` in `Layout.astro`. Source: `src/components/Consent.astro`, `src/layouts/Layout.astro`.

## Deploy leaves removed files live

Every push to `main` builds the site and runs `bunny-transfer move ./dist`, then purges the pull zone. Unlike `sync`, `move` keeps destination files that are no longer in `dist`, so deleted or renamed pages and assets stay live on the storage zone until removed by hand. Source: `.github/workflows/deploy.yml`, `bunny-transfer/README.md`.
