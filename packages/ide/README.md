# @appling/ide

A local, browser based IDE for Appling models: the canonical text and the model as a zoomable graph, side by side.

```sh
npx @appling/ide [folder] [--port 4410]
```

It serves the folder's `.appling` files on `http://127.0.0.1:4410` and only answers pages it served itself.

## What you get

- A text editor (Monaco) backed by the Appling language server: diagnostics, completion, hover, go to definition, references, rename and formatting. Ctrl+S (Cmd+S) saves.
- The graph with semantic zoom. Zoomed out: modules, their use cases and the dependencies between modules, with the number of references behind each. Medium: the declarations of each module and the references between them. Zoomed in: declarations with their members. The buttons switch levels too.
- Selection in sync: moving the cursor selects the element in the graph and the inspector, clicking the graph or the inspector reveals the text.
- An inspector with the element's properties, members and references in both directions.
- Layout stays out of the model, in `.appling/layout.json`, and follows renames recorded as migration steps.

The graph and the files update when the files change on disk.

## License

MIT
