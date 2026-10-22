---
paths:
  - packages/landing/**
---

# Landing site

- Do not add `tailwind.config.js` or `@astrojs/tailwind`; tokens go in `src/styles/global.css` under `@theme`.
- Write valid HTML; Astro 7 fails the build on unclosed tags and no longer corrects invalid nesting.
- Gate every new animation behind `prefers-reduced-motion`, as `global.css` and `Mascots.astro` do.
- Load analytics and third party scripts only through the consent gate in `Consent.astro`.
- Add every new page to `public/sitemap.xml` by hand; no sitemap integration is installed.
- Take external URLs from `src/links.ts`.
- Before changing these files, use the `landing-site` skill.
