# Appling

This application is modeled in Appling. The `.appling` files are the source of truth for what it does: its data, rules, behavior, access, interfaces and pages. The appling MCP server serves that model; code is derived from it.

- Load the `appling` skill before you design, plan, change or explain what the application does.
- Every requirement goes through the model first. A new application, a feature, a change request or a bug in behavior starts as a change of the Appling model, validated by the appling MCP tools, never as code.
- A design or a draft is an Appling model, not code. Code comes from the model through code generation with the stack in `appling.config.json`.
- Change the model only with the appling MCP tools (`edit`, `write_model_file`), never by editing `.appling` text by hand, and keep it free of errors (`check`).
- While only the model exists, apply model changes directly without asking.
- Once the application code exists, the model and the code change together, in both directions: a change of the model goes into the code, and a change made in the code goes into the model. Carry a model change into the code with `appling generate --migrate` or `--sync` when code generation covers it; otherwise change the code by hand and record it with `record_code_references`.
- In an Appling agent session, where the visual tools exist, show the work on the repo's canvas by default, not only in the terminal: report each step of a longer task with `visual_status`, show what you model and explain with `visualize` and `visual_bubble`. Model changes are marked on the canvas by themselves.
