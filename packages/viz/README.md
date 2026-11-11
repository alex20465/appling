# @appling/viz

The views of an Appling model and the canvases that draw them: the pure view logic and the SVG canvases of the repo view in [Appling Desktop](https://appling.tools/docs/tools/desktop/), and the messages of the visual tools that agent sessions use to show the model there.

## Visual tool messages

The root export (also `@appling/viz/protocol`) has the types the visual tools of `@appling/ai` and the IDE server exchange.

| Export | Purpose |
|---|---|
| `Show`, `Bubble`, `Review`, `Decision`, `Selection`, `Status` | A view of focused elements with a title and note, a note or code example on an element, a proposal, the decision on it, the person's selection and view, the step the agent works on |
| `nextShow(current, next)` | The view after the next one: `node` views add up and keep their bubbles |

## Views

`@appling/viz/views` has no React or DOM imports.

| Export | Purpose |
|---|---|
| `requestKinds(node)`, `REQUEST_KINDS` | The kinds a person may request under a tree node, by the layer rules |
| `growTree(index, settings, unfolded, name?, trail?, requests?)` | The dependency tree of one lens (`domain`, `behavior`, `application`, `interfaces`, `access`): modules, then the lens's declarations, then what uses each unfolded declaration, the most relevant first; trail nodes show only the children on the trail |
| `trailOf(index, settings, focus)`, `lensOf(kind)` | The tree state that draws elements one after another, each unfolded in place; the lens of a kind |
| `modelPulse(before, after, qns)` | Which of these elements a new model added, or changed in itself or in something it holds |
| `revealPath(index, settings, qn)`, `factOf(index, node)` | The node ids that show a declaration, and the fact a node shows under its name |
| `cardView(index, view, focus)` | The `action` or `event` view as cards of facts |
| `flowView(index, view, focus)` | The `machine` or `usecase` view as a flowchart: states and transitions, or steps in order with their error handlers and timeouts. `FlowCanvas` routes edges with right angle corners; with `edgesOnClick`, as for machines, it draws only the edges of the clicked node |
| `changeMarks(index, changes, modules?)` | The marks of a model change (such as a `GraphDiff` from `@appling/model/diff`, or an AI session's changes) per declaration: `added`, `changed` or `removed`, members lifted to their declaration, optionally their modules too |
| `GraphIndex`, `search`, `relations`, `entityActions`, `actionSummary` | The index and queries the IDE side panel uses |

`@appling/viz/canvas` exports `ModelCanvas`, the tree that grows from a seed, sizes its circles by relevance and marks optional `changes` (removed elements drawn ghosted when its index comes from `withRemoved`), sends a wave from the drawn elements a new `index` added or changed and plays soft sounds a button switches off, `FlowCanvas` and `CardCanvas`, each drawing optional bubbles; import `@appling/viz/canvas.css` with them. `react` is a peer dependency.

## License

MIT
