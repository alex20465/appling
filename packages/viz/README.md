# @appling/viz

The views of an Appling model and the canvases that draw them: the pure view logic and the SVG canvases of the [Appling inspector](https://appling.tools/docs/tools/inspect/), and the messages of the visual tools that agent sessions use to show the model there.

## Visual tool messages

The root export (also `@appling/viz/protocol`) has the types the visual tools of `@appling/ai` and the inspector server exchange.

| Export | Purpose |
|---|---|
| `Show`, `Bubble`, `Selection`, `Status` | A view of focused elements with a title and note, a note or code example on an element, the person's selection and view, the step the agent works on |
| `nextShow(current, next)` | The view after the next one: `node` views add up and keep their bubbles |

## Views

`@appling/viz/views` has no React or DOM imports.

| Export | Purpose |
|---|---|
| `growTree(index, settings, unfolded, name?, trail?)` | The pyramid from an entry level (`settings.lens`: `domain` L1, `behavior` L2, `application` L3, `interfaces` L4, `access` L5): modules, then their declarations of the entry level, then for each side of a declaration whose `sideId(id, 'up' \| 'down')` is unfolded the declarations of higher levels that rest on it or of lower levels it rests on; a declaration is drawn once, and what else leads to it lists it in `links`; trail nodes show only the children on the trail |
| `linked(index, qn, side)`, `peers(index, qn)`, `levelOf(kind)` | The declarations one step up or down from a declaration (for a role, actor or tenant through the pages and interfaces that expose what its policies name); those of its own level it belongs together with; the level of a kind, 1 to 5 |
| `trailOf(index, settings, focus)`, `lensOf(kind)` | The pyramid state that draws elements one after another, each unfolded in place; the level whose band holds a kind |
| `modelPulse(before, after, qns)` | Which of these elements a new model added, or changed in itself or in something it holds |
| `revealPath(index, settings, qn)`, `factOf(index, node)` | The node ids that show a declaration, and the fact a node shows under its name |
| `cardView(index, view, focus)` | The `action` or `event` view as cards of facts |
| `flowView(index, view, focus)` | The `machine` or `usecase` view as a flowchart: states and transitions, or steps in order with their error handlers and timeouts. `FlowCanvas` routes edges with right angle corners; with `edgesOnClick`, as for machines, it draws only the edges of the clicked node |
| `useCaseDiagram(index, level?)` | The use case diagram of the whole model: the actors, the use cases and the actions their steps call as subfunctions, an association where a use case's policy names the actor or one of its roles, and include where a step calls a use case or an action. `layoutUseCases` places it as chips and `UseCaseCanvas` draws it in the chips of the level canvas |
| `screenFlow(index, actor, level?)` | The mockup of one actor: the pages it may read or act on with their components and only its actions, the page a list row opens, the navigations as menus cut to those pages, and the steps of the flows of the use cases it starts. `ScreenCanvas` draws it as an application in a browser window |
| `layoutStates(flow)` | A machine's flow as a UML state diagram: top down from the initial state to the states nothing leaves, one curve per pair of states, a trigger from many states or into many states as a bundle beside its target (`bundle`), transitions that lead back marked `back`, the initial pseudostate. `FlowCanvas` draws it with `states` |
| `changeMarks(index, changes, modules?)` | The marks of a model change (such as a `GraphDiff` from `@appling/model/diff`, or an AI session's changes) per declaration: `added`, `changed` or `removed`, members lifted to their declaration, optionally their modules too |
| `GraphIndex`, `relations`, `entityActions`, `actionSummary` | The index and queries the inspector uses |

`@appling/viz/icons` exports `iconOf(name)`, the shapes of a [Lucide](https://lucide.dev/icons) icon by its name, and `ViewSettings.icons` maps nodes to icon names.

`@appling/viz/canvas` exports `ModelCanvas`, the pyramid of five level bands drawn as a circuit board (a rail of yellow L1 to L5 labels picks the entry level, modules frame its declarations, every declaration is one chip with an unfold tab on top and one below that keeps its place when others unfold, and every trace, also to a declaration drawn elsewhere already, runs on a track of its own in the color of the level it starts from) and marks optional `changes` (removed elements drawn ghosted when its index comes from `withRemoved`), sends a wave from the drawn elements a new `index` added or changed and plays soft sounds a button switches off, `FlowCanvas` and `CardCanvas`, each drawing optional bubbles, the diagrams `UseCaseCanvas` and `ScreenCanvas`, and `Select`, the dropdown of the canvases (`qualifiedOptions` turns qualified names into its options); import `@appling/viz/canvas.css` with them. `react` is a peer dependency.

## License

MIT
