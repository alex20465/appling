# @appling/ide

A local, browser based IDE for Appling models: the canonical text next to a map of the modules and entities, with a search over every element.

```sh
npx @appling/ide [folder] [--port 4410]
```

It serves the folder's `.appling` files on `http://127.0.0.1:4410` and only answers pages it served itself.

To try it without installing anything, open the demo at https://appling.tools/ide/: the same IDE on the sample sales and CRM model, with the language server running in the browser. Edits stay in the page until you reload, and the AI tab needs a local IDE with an API key.

## What you get

- A text editor (Monaco) backed by the Appling language server: diagnostics, completion, hover, go to definition, references, rename and formatting. Ctrl+S (Cmd+S) saves.
- The model canvas, a tree that grows from a seed and unfolds on click: modules, then the declarations of the lens (Domain, Behavior, Application, Interfaces or Access), then what uses each declaration, grouped by kind. Each circle shows its name, kind and one fact; relevance decides its size and place, so the core of the business stands out. Clicking a circle unfolds and inspects it.
- The lens and the link entities option (`entity link`, such as join records, hidden by default) are saved in `.appling/view.json`.
- Search over every element (entities, fields, actions, machines, queries, use cases, endpoints, pages and more), grouped and filtered by layer.
- Selection in sync: moving the cursor selects the element on the canvas and in the inspector; clicking a circle, a search result or the inspector reveals the text.
- For actions the inspector shows which actors may trigger them and which invariants they put at risk, for machines which states are reachable and how, answered by the simulator.
- An inspector that explains the element: for an action what it does (input, requires, changes, errors), for an entity its actions with the transitions they drive, for an actor what that person may do (actions, pages with the actions they offer, use cases, queries, data) and the policies that decide it, where it is implemented (its code references, with the lines), then its members and what uses it and what it uses, grouped by layer and with the members each link runs through. You also edit the model there: rename, change a type, set any property, add a member from its source text, or remove the element.
- Every edit goes through the Appling edit operations: the touched text is printed canonically, the edit is rejected with the reasons when it would introduce errors, and it lands in the editor as one undoable step. Renames follow references, expressions, exports and message keys.
- An AI tab: ask about the model or ask for changes. The assistant looks things up in the graph and edits a working copy; its changes come back as a proposal with the text and graph differences, which you accept or reject. Set the model in `appling.config.json` (`"ai": { "provider": "anthropic", "model": "claude-opus-5-5" }`) and the provider's API key in the environment.
- Once a release exists (`appling release`), the header shows how many migration steps were recorded since; renames, type changes and removals of released domain elements add them automatically.

The views and the files update when the files change on disk.

## License

MIT
