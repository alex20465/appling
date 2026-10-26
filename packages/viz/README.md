# @appling/viz

The views of an Appling model and the windows that draw them: the pure view logic and the SVG canvases shared by the Appling IDE, and the floating visualization window that `appling-mcp` opens next to a Claude Code session.

## Visualization window

```ts
import { Visualizer } from '@appling/viz';

const window = new Visualizer({ root: 'models', graph: () => project.graph() });
await window.show({ view: 'machine', focus: ['sales.OrderFlow'], title: 'Order lifecycle' });
window.bubble({ target: 'sales.OrderStatus.paid', text: 'Set when the payment arrives' });
const decision = await window.review({ summary: 'Add a phone number', hunks, graph });
```

The window is a frameless Electron window at the top right of the main screen, above every other window, opened without taking the focus. It runs on macOS, Windows and Linux; on Wayland sessions it runs through XWayland, since Wayland lets no application keep a window on top. The host serves it on `127.0.0.1` with a random token, checks Host and Origin, starts Electron on first use (downloading its binary once) and pushes a new graph when `.appling` files change. Electron ends with the process that started it. A file and line clicked in the window opens in the editor `launch-editor` finds.

| Export | Purpose |
|---|---|
| `Visualizer` | `show(show)`, `bubble(bubble)`, `selection()`, `reply(text, askId)`, `review(review)`, `onAsk(listener)`, `close()` |
| `Show`, `Bubble`, `Review`, `Decision`, `Ask`, `Selection` | What the window draws, a note or code example on an element, a proposal, the decision on it, a question typed into the window, the current selection |
| `nextShow(current, next)` | The view after the next one: `node` views add up and keep their bubbles |

## Views

`@appling/viz/views` has no React or DOM imports.

| Export | Purpose |
|---|---|
| `growTree(index, settings, unfolded, name?, trail?)` | The dependency tree of one lens (`domain`, `behavior`, `application`, `interfaces`, `access`): modules, then the lens's declarations, then what uses each unfolded declaration, the most relevant first; trail nodes show only the children on the trail |
| `trailOf(index, settings, focus)`, `lensOf(kind)` | The tree state that draws elements one after another, each unfolded in place; the lens of a kind |
| `revealPath(index, settings, qn)`, `factOf(index, node)` | The node ids that show a declaration, and the fact a node shows under its name |
| `cardView(index, view, focus)` | The `action` or `event` view as cards of facts |
| `flowView(index, view, focus)` | The `machine` or `usecase` view as a flowchart: states and transitions, or steps in order with their error handlers and timeouts. `FlowCanvas` routes edges with right angle corners; with `edgesOnClick`, as for machines, it draws only the edges of the clicked node |
| `GraphIndex`, `search`, `relations`, `entityActions`, `actionSummary` | The index and queries the IDE side panel uses |

`@appling/viz/canvas` exports `ModelCanvas`, the tree that grows from a seed and sizes its circles by relevance, `FlowCanvas` and `CardCanvas`, each drawing optional bubbles; import `@appling/viz/canvas.css` with them. `react` is a peer dependency.

## License

MIT
