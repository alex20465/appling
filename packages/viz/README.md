# @appling/viz

The views of an Appling model and the windows that draw them: the pure view logic and the SVG canvases shared by the Appling IDE, and the floating visualization window that `appling-mcp` opens next to a Claude Code session.

## Visualization window

```ts
import { Visualizer } from '@appling/viz';

const window = new Visualizer({ root: 'models', graph: () => project.graph() });
await window.show({ view: 'machine', focus: ['sales.OrderFlow'], title: 'Order lifecycle' });
const decision = await window.review({ summary: 'Add a phone number', hunks, graph });
```

The window is a frameless Electron window at the top right of the main screen, above every other window, opened without taking the focus. It runs on macOS, Windows and Linux; on Wayland sessions it runs through XWayland, since Wayland lets no application keep a window on top. The host serves it on `127.0.0.1` with a random token, checks Host and Origin, starts Electron on first use (downloading its binary once) and pushes a new graph when `.appling` files change. Electron ends with the process that started it.

| Export | Purpose |
|---|---|
| `Visualizer` | `show(show)`, `selection()`, `reply(text, askId)`, `review(review)`, `onAsk(listener)`, `close()` |
| `Show`, `Review`, `Decision`, `Ask`, `Selection` | What the window draws, a proposal, the decision on it, a question typed into the window, the current selection |

## Views

`@appling/viz/views` has no React or DOM imports.

| Export | Purpose |
|---|---|
| `growTree(index, settings, unfolded)` | The dependency tree of one lens (`domain`, `behavior`, `application`, `interfaces`, `access`): modules, then the lens's declarations, then what uses each unfolded declaration, the most relevant first |
| `revealPath(index, settings, qn)`, `factOf(index, node)` | The node ids that show a declaration, and the fact a node shows under its name |
| `cardView(index, view, focus)` | The `machine`, `action`, `usecase` or `event` view as cards: per state what can be done there, per action, use case or event its facts |
| `GraphIndex`, `search`, `relations`, `entityActions`, `actionSummary` | The index and queries the IDE side panel uses |

`@appling/viz/canvas` exports `ModelCanvas`, the tree that grows from a seed and sizes its circles by relevance, and `CardCanvas`; import `@appling/viz/canvas.css` with them. `react` is a peer dependency.

## License

MIT
