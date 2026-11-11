---
name: ui-sandbox
description: See, use and judge the Appling IDE the way a person does, in a sandbox (the IDE in a browser, VS Code through openvscode-server, the VS Code desktop app, Appling Desktop) driven through the `sandbox` Playwright MCP server over Chrome DevTools. Screenshots, accessibility snapshots, console and network, human presses. Use when asked how the IDE looks or feels, to try or walk through a UI flow, to verify a UI change in the real app, or to find and fix visible problems in the IDE client, the VS Code extension or Desktop.
---

# UI sandbox

`scripts/sandbox/start.mjs <target>` (`pnpm sandbox <target>`) starts one target in the foreground on a fresh copy of `examples/` in `.sandbox/workspace` (a git repo with one base commit, so Review has something to compare against). Every target listens for Chrome DevTools on `127.0.0.1:9222`, and the `sandbox` server of `.mcp.json` (`@playwright/mcp` with `--cdp-endpoint`) connects to it on its first tool call. Only one target runs at a time.

| Target | What starts | Pages in `browser_tabs` |
|---|---|---|
| `ide` | IDE server at `127.0.0.1:4410` and a Chrome app window | the IDE client |
| `openvscode` | openvscode-server at `127.0.0.1:4411` (cached in `.sandbox/cache`) with the built `appling.vsix` and a Chrome app window | the VS Code workbench; the IDE tab is a webview, its client sits in nested iframes |
| `vscode` | `code` with its own profile in `.sandbox/vscode` and `--extensionDevelopmentPath packages/vscode` | the workbench window (plus its webviews as their own targets) |
| `desktop` | Electron with its own user data in `.sandbox/desktop` and its own pty host | the shell page (rail), one page per repo view, terminal and code view |

## Starting

Never start a target yourself. Ask the user with AskUserQuestion to run, in a terminal of their own:

1. the build of what changed (`pnpm build`, or `pnpm --filter "@appling/ide..." build`; `openvscode` and `vscode` need `pnpm --filter "appling-vscode..." build`, `desktop` needs `pnpm --filter "@appling/desktop..." build`);
2. `pnpm sandbox <target>`.

The `sandbox` tools exist only after the session loaded `.mcp.json`; if they are missing, ask the user to approve the server and restart the session. A tool error about connecting to 9222 means no sandbox runs.

## Looking

- `browser_tabs` first, then select the page that holds what you want to judge.
- `browser_take_screenshot` for look and layout (save under `.sandbox/output`), `browser_snapshot` for structure and refs to act on. Judge from the screenshot, act from the snapshot.
- After each step read `browser_console_messages` (errors and warnings) and, when something failed to load, `browser_network_requests`.
- Check both themes (`browser_emulate_media` with `prefers-color-scheme`) and a narrow window (`browser_resize` to about 1000x700) for the IDE target.
- Inside VS Code the IDE client is several iframes deep; snapshot refs reach into frames, `browser_evaluate` does not, so use refs or `browser_run_code_unsafe` with `page.frameLocator(...)`.

## Pressing

Synthetic clicks hide bugs. To claim a click works or is fixed, press like a person: `browser_mouse_move_xy` onto the target, `browser_mouse_down`, wait about 150ms (`browser_wait_for` with a time), `browser_mouse_up`, and confirm the element under the pointer stayed the same DOM node throughout (`browser_run_code_unsafe` with `document.elementFromPoint` before and after). `browser_click` is fine for getting somewhere, not as proof.

## Walkthrough

Cover the flows touched by the task, or all of them for a general review:

1. Load: no console errors, the canvas draws the module tree, nothing is clipped or overlapping.
2. Canvas: pan, zoom, unfold a module and a declaration; the camera follows; circles sized by relevance.
3. Search: find an element, open it; the inspector shows it.
4. Inspector edit: rename a field; the canvas and **Source** follow, the edit is undoable in the editor, the file saves.
5. Review: after the edit, the diff against the base commit lists it and marks it on the canvas.
6. Changes, Playbook, Code tabs: each opens, shows its empty state sensibly, nothing throws.
7. Target specific: in VS Code the Appling sidebar trees, **Appling: Open the IDE**, **Appling: Show in the IDE** from a `.appling` editor; in Desktop the rail, Ctrl+Tab switcher, terminal panel and code view.

## Problems

- **Obvious** (console errors, failed requests, broken or clipped layout, dead or missed clicks, wrong state after an action, unreadable contrast): find the cause in the source, fix it, add a test where the package has them (`packages/viz/test` for view logic, `packages/ide/test` for the server), rebuild the package, have the user restart the target if the fix lives in a server or extension (a client only fix needs only `browser_navigate` to the same URL in `ide`, or **Developer: Reload Window** in VS Code), then verify again with a screenshot and a human press.
- **Judgment calls** (spacing, wording, flow, what feels slow or confusing): do not change them. List each with its screenshot path and ask the user; how something feels to a person is theirs to say.

End with a short report: what was walked, what was fixed (file and test), what is left for the user to judge.
