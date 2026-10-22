# @appling/ide

A local, browser based IDE for Appling models: the canonical text and the model as a zoomable graph, side by side.

```sh
npx @appling/ide [folder] [--port 4410]
```

It serves the folder's `.appling` files on `http://127.0.0.1:4410` and only answers pages it served itself.

## What you get

- A text editor (Monaco) backed by the Appling language server: diagnostics, completion, hover, go to definition, references, rename and formatting. Ctrl+S (Cmd+S) saves.
- The graph with semantic zoom. Zoomed out: modules, their use cases and the dependencies between modules, with the number of references behind each. Medium: the declarations of each module and the references between them. Zoomed in: declarations with their members. The buttons switch levels too.
- Layer views: the declaration and member levels show only the layers you pick (Domain, Behavior, Application, Interfaces, Experience, Cross cutting), and only the references among them, one line per pair of declarations. Domain alone is the default; the choice is saved with the layout.
- Selection in sync: moving the cursor selects the element in the graph and the inspector, clicking the graph or the inspector reveals the text.
- For actions the inspector shows which actors may trigger them and which invariants they put at risk, for machines which states are reachable and how, answered by the simulator.
- An inspector with the element's properties, members and references in both directions, where you edit the model: rename, change a type, set any property, add a member from its source text, or remove the element.
- Editing in the graph: drag from a declaration to an entity, enum or value type to add a field that references it, press Delete to remove the selected element.
- Every edit goes through the Appling edit operations: the touched text is printed canonically, the edit is rejected with the reasons when it would introduce errors, and it lands in the editor as one undoable step. Renames follow references, expressions, exports and message keys.
- An AI tab: ask about the model or ask for changes. The assistant looks things up in the graph and edits a working copy; its changes come back as a proposal with the text and graph differences, which you accept or reject. Set the model in `appling.config.json` (`"ai": { "provider": "anthropic", "model": "claude-opus-5-5" }`) and the provider's API key in the environment.
- Once a release exists (`appling release`), the header shows how many migration steps were recorded since; renames, type changes and removals of released domain elements add them automatically.
- Layout stays out of the model, in `.appling/layout.json`, and follows renames recorded as migration steps.

The graph and the files update when the files change on disk.

## License

MIT
