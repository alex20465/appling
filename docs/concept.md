---
title: Design concept
description: The design specification of Appling v2, covering layer ownership, reference rules, narrowing, identity by qualified name, visualization, validation and AI.
---

## 1. Vision

*Appling: grow your app from one seed.*

Create a declarative Domain-Specific Language (DSL) that describes the structural and behavioral model of a business or web application.

The model is the **single source of truth**. It has a canonical text syntax that round-trips losslessly to an Abstract Syntax Tree (AST). After reference resolution, the AST becomes a semantic graph. All tools (visualization, AI, validation) work on that graph.

The primary goal is an **interactive visualization** that both humans and AI can explore, construct, and modify, backed by a model that can be **validated structurally and simulated behaviorally**. Code generation produces a draft project for a target framework (Django and Ash first) through installable extensions; work it cannot complete is recorded as tasks for AI or humans.

**What the model reflects:** the business logic as a domain expert sees, understands and describes it. The model is not a mirror of the code. It says what matters to the world outside the system: who uses the platform, what they can start, what the business decides and what follows from it. How the code carries that out, with its helpers, workers, tokens and retries, is internal. A model derived from an existing application is an abstraction of its implementation, never a one to one copy (section 8).

**Differentiator:** layered application modeling exists already (WebML/IFML, MDA, Ash, Mendix). This project's distinct contribution is AI-native editing plus semantic-zoom exploration of one validated model.

## 2. Model Structure

> [!NOTE]
> The [language reference](language/overview.md) describes what the tools accept today. This page is ahead of it in one place, which the grammar follows: a use case holds its own input, preconditions and effects, so `action` is no declaration of its own and use cases move to Layer 2.

### 2.1 Cross-cutting concepts

These are not layers. They apply across all layers.

**Modules (bounded contexts)**
- Every model element belongs to exactly one module.
- Modules may contain sub-modules and form the containment hierarchy of the visualization.
- Cross-module references must go through elements the target module explicitly exports.

**Identity and access**
- Actors, roles, and tenants.
- An actor is **who** acts, never how they connect. There are three kinds:
  - a **human** actor is a kind of person or organization that uses the platform, named the way the business names them: `Admin`, `Operator`, `Partner`, `Guest`.
  - a **third party** actor is an outside system that calls in on its own, named after that system and nothing else: `Webhotelier`, never `WebhotelierWebhook` or `WebhotelierApiToken`.
  - the **system** actor is the application acting on its own, on a schedule or as a consequence of an event. There is exactly one, `System`. Workers, queues, background jobs and code that skips authorization are all `System`.
- A session, an API key, a token or a webhook signature is a credential. It is the `auth` of an interface (Layer 4) and never an actor: an operator who calls the API with a key is the same `Operator` with the same permissions.
- A role is declared only where one actor holds different business permissions, such as an `Operator` who is also `Manager` of a property. An actor needs no role, and a role never restates an actor.
- Each policy, wherever it is defined, refers to these concepts.
- The current actor and tenant are always available in the expression context.
- Actors declare typed fields, such as the account a human user acts for, and may be bound to the entity that stores them (`actor human Employee is User`), whose fields they then read too. In expressions, `actor.is(Operator)` tests the actor or one of its roles and `actor.field` reads a field declared by at least one actor or its entity. The field is null for actors that do not declare it.
- A role may hold a condition on the actor (`role Operator { actor.active }`) that reads only `actor`, `tenant` and `now`. `actor.is(Role)` means the actor carries the role and the condition holds. Conditions on the guarded record stay in policies; named entity conditions are derived Bool fields; what a role may do is derived from the policies, not written in the role.

**Relevance**
- How much a module or top level declaration matters to the business, from 0 to 1. The graph computes it from what uses a declaration and what it uses; a declared level, on the declaration or inherited from its module, maps it into a fixed range, so a person's judgment of the business wins over connectivity.
- The levels, from the view of a domain expert:
  - `core`: what they name when they describe the business in a sentence or two.
  - `supporting`: what the business needs around the core, such as a table that links two important records, or a history.
  - `peripheral`: minor business housekeeping.
  - `internal`: what no domain expert would name at all, such as tables for API keys, webhook events and job state, or fields for internal tokens. It exists in the data, so the model holds it, but it is not business logic.
- Entities and their fields carry a level, so all persisted data stays in the model without hiding the business.
- Every view shows only `core` by default. A person switches the other levels on one by one.

**Expression language**
- A small, typed, side-effect-free language used for constraints, policies, guards, derived fields, and filters.
- It has defined semantics, so it can be evaluated by the validator and the simulator.

**Scenarios**
- A scenario is an example of behavior: given rows, as an actor, when one use case starts, then checks hold, the call fails with an error, or a policy refuses it.
- It is a module member outside the five layers and may reference anything its module sees. It owns no concept; it only uses them.
- The simulator runs every scenario in `appling check`, and a scenario whose `then` does not hold is an error. Every code generation target turns it into a real test, which replaces the tests a generator would otherwise guess for the element it covers.

### 2.2 Layers

Each concept has exactly one owning layer. Other layers reference it. They never redefine it.

#### Layer 1 — Domain / Data

Describes what exists.

- Entities, attributes, relationships
- Data types, value objects, enumerations
- **Invariants:** constraints that must hold for every persisted instance, such as uniqueness, required fields, and cross-field rules like `end > start`.
- Derived (computed) fields and aggregates
- State **field** declaration (the set of possible states), without transitions
- Files/blobs as a data type
- Entity-level access policies (row- and field-level)

#### Layer 2 — Behavior / Time

Describes what can happen: the decisions the business takes and what follows from them.

- **Use cases:** the single behavior concept and the only entry into the system. A use case is one thing an actor starts that decides something for the business: send a quote, accept it, expire it. It names who starts it (`usecase SendQuote by Operator`), and has input, **preconditions**, effects, and declared errors. Every use case has at least one actor, a human, a third party or `System`.
- Steps: the inside of a use case, as plain lines in the words of a domain expert ("hold the rooms", "send the proposal to the guest"). A step is not a declaration and has no name outside its use case. Tools show steps only when the use case is opened.
- What only supports a decision is not a use case. Code that sets a field, stores a link, retries, logs or completes a transition is part of the effects of the use case it serves, or stays in the code. Setting the payment URL of an offer supports accepting a quote; it decides nothing.
- Effects: `set` a field of the record, `create` a record (`as name` names it for the effects after it), `emit` an event, `for x in <collection relationship>` to repeat effects per related record, `update <relationship path> { set ... }` to change a related record, and `delete self` or `delete <relationship path>`. A loop iterates only collection relationships of the use case's entity; paths start at a field, a loop variable or an `as` name and lead to one record. All effects of one use case run in one transaction. `delete` removes the record for good; archiving instead belongs to the data lifecycle.
- State machines: own the transitions over a Layer 1 state field. Each transition has guards and effects, and is triggered by use cases or events.
- Events (domain events emitted by use cases or transitions)
- Jobs: the schedule or event on which `System` starts a use case
- Transaction / consistency boundary per use case
- Access: the actors a use case names are the ones who may start it; a policy adds conditions on the record, such as ownership

Rule of placement: something that must always be true belongs in Layer 1 as an invariant. Something that must be true for a use case to start belongs in Layer 2 as a precondition.

#### Layer 3 — Application

Describes how domain capabilities are organized for practical use.

- **Queries:** filtered, sorted, paginated access to entities. They inherit entity policies. A query may declare typed **inputs** like a use case's (`input { of: Customer, since: Date? }`); its filter and policies read them, and an interface takes them from the request (the path for `{name}` parameters, the query string for the rest). An optional input is null when it is not given, and the filter says itself what null means (`since == null || placed_at >= since`).
- **Projections** (renamed from "views of data"): shaped read models over entities and queries. This is the **only** place where a shape may diverge from the entity, for example API versions or DTOs.
- External systems: the systems this application calls, declared as dependencies with typed operations. A system that calls in on its own is a third party actor (2.1); the same company may be both.
- Query-level access policies

#### Layer 4 — Interfaces / Transport

Describes how application capabilities are exposed to non-human or programmatic consumers.

- REST APIs, GraphQL schemas, MCP interfaces, webhooks, other protocols
- Mapping from endpoints to use cases, queries, and projections. A query endpoint takes the query's inputs from the request: each `{name}` in its path names an input, the other inputs come from the query string.
- Transport-specific policies: auth scheme, rate limits, CORS. These may only add restrictions. The auth scheme says how an actor proves who it is (session, API key, token, signature); it never creates an actor.

Web routes for human-facing pages are owned by Layer 5, not Layer 4.

#### Layer 5 — User Experience

Describes what humans can see and interact with.

- Navigation and menu structures, nested: a menu has sub menus, and a page below another page in the route is reached from its parent
- Pages with their routes/URLs
- Forms, lists, detail views, bound to use cases, queries, and projections. What a page offers is grouped by the part of the page it belongs to, never one flat list.
- User-facing workflows, which reference use cases and do not redefine process logic
- Presentation, interaction, and i18n (localized labels and messages)

Not every entity or use case must be exposed through an interface or a user interface.

### 2.3 Reference rules

Allowed references form a directed acyclic graph:

| From | May reference |
|---|---|
| L2 Behavior | L1 |
| L3 Application | L1, L2 |
| L4 Interfaces | L1 (types only), L2 use cases, L3 |
| L5 Experience | L1 (types only), L2 use cases, L3 |
| Any layer | Cross-cutting concepts |
| Scenarios | Everything visible to them |

- L4 and L5 are siblings, and neither references the other.
- Lower layers never reference higher layers.
- The validator rejects any other edge.

## 3. Core Design Principles

**Single source of truth:** Each concept is defined once, in its owning layer, and referenced everywhere else.

**Bottom-up inheritance with monotonic narrowing:** Higher layers inherit definitions, constraints, and policies from lower layers. They may only narrow them, by exposing fewer fields or applying stricter policies. They may never widen them. Intentional divergence of shape happens only through Layer 3 projections.

**Local policies:** Access policies are defined next to the concepts they protect: entities, use cases, and queries. The effective policy at any point is the conjunction of all policies along the reference path: a use case on an entity needs the entity's `update` policies whatever it does, a `create` the created entity's `create` policies, an `update` or `delete` of a related record that entity's `update` or `delete` policies, a query its entity's `read` policies. Nothing is open by default: a policy grants by actor or role (`actor.is(Operator)`, with conditions), and an actor that nothing names may do nothing.

**Explicit exposure:** Interfaces, navigation, pages, and module exports are intentionally declared, never derived from the mere existence of entities.

**Separation of concerns:** Domain behavior is independent of its presentation or transport.

**Extensibility through extensions:** New capabilities, such as a protocol, a UI pattern, or a data type, are added as extensions. An extension contributes new element kinds, their validation rules, and their visualization, without changes to the core.

## 4. Interactive Visualization

The visualization serves a domain expert who needs to understand the business logic. It draws little and lets the person ask for detail. It starts with what is `core` (2.1) and leaves every other relevance level off until asked for:

- **Model tree:** one lens at a time (domain, behavior, application, interfaces, access) grows as a tree from a seed: modules, then the lens's declarations, then on each unfold the declarations that use the unfolded one, grouped by kind. Nothing is drawn until asked for. Each circle says what it is (name, kind, one fact); its relevance sets its size and its place in the row. Secondary entities, such as join records marked `entity link`, are hidden until asked for. Fields, invariants and policies are never drawn in the tree.
- **Diagrams:** three views a domain expert already reads. The use case diagram joins every use case to the actors that start it. The state diagram of a machine runs top down, the start states on top and the end states at the bottom, whatever connects most. The screens of one actor follow the nested navigation and group what each page offers.
- **Search:** every element of every layer, filtered by layer, as the way into behavior, application logic, interfaces and pages.
- **Inspector:** the selected element in detail: its members, and the declarations that use it and that it uses, grouped by layer. For an entity this shows its behavior, queries, use cases, endpoints and pages in one place.

Rules:

- Every view is a projection of the semantic graph, not a separate source of truth.
- Modules nest by the module containment hierarchy. Aggregated nodes and edges, such as module-to-module dependencies, are computed from the model, never drawn by hand.
- Every model element is identified by its **qualified name**, such as `sales.Order.status`, so graph edits map back to exact AST nodes. Renames are recorded as migration steps, so tools can follow an element to its new name.
- Elements without a name are identified by a key derived from their content, written in brackets after their kind: `sales.Order.invariant["total never negative"]`, `sales.Order.policy[read fields total]`, `sales.OrderFlow.transition[draft,placed->cancelled]`, `sales.PublicApi.endpoint[GET /orders]`, `sales.PlaceOrder.effect[set placed_at]`. When two siblings share a key, an ordinal is appended, such as `policy[read]#2`.
- Layout and view state (positions, collapsed groups, saved views) are stored **separately** from the model. They are not part of the truth and do not appear in model diffs.

## 5. Validation and Simulation

**Structural validation (always on):**
- References resolve
- Types match
- Reference rules (2.3) hold
- Narrowing rule holds
- Each concept has one owner

**Behavioral simulation (initial scope):**
- Evaluates expressions, use case preconditions and effects, and state machine transitions against sample data and actors.
- Answers questions such as "Can an order reach Paid?", "Which actors can trigger Cancel?", and "Which invariants does this use case risk violating?"
- Runs every scenario (2.1) as part of validation: its given rows, its actor and its call, then checks its expected outcome. What a scenario does not give is unknown, and a result that depends on it fails the scenario instead of being guessed.

Production runtime remains out of scope (section 8). The simulator is the minimum that makes behavior verifiable.

## 6. AI Integration

AI acts as a participant in the modeling process.

It should be capable of:
- Constructing and modifying the model through the canonical text syntax or equivalent AST operations
- Creating entities, rules, use cases, and interfaces
- Understanding relationships and dependencies through the semantic graph
- Explaining behavior, using the simulator rather than guessing
- Proposing changes and identifying inconsistencies

AI-generated changes pass the same structural validation as human edits, and are presented as reviewable diffs.

## 7. Model Evolution

- The model is versioned with its text representation, for example in git.
- Changes to Layer 1 that affect persisted data, such as renames, type changes, or removals, are recorded as explicit migration steps in the model.
- Migration steps target elements by their qualified name as it was before the step, so layout and history can follow renames.
- Once a release exists, editing a Layer 1 element it contains appends the step automatically. Steps go into one migration block per module, named after the release they follow, such as `since_v1_0_0`.

## 8. What Belongs in the Model

### 8.1 What a model contains

A model is written the way a domain expert sees, understands and describes the application. For each thing found in an application, ask how they would put it:

| A domain expert would | In the model |
|---|---|
| name who does it | an actor: a person or organization, a third party, or `System` |
| say "the operator sends the quote" or "a quote expires after its deadline" | a use case, started by that actor |
| describe what happens inside, in their own words | plain steps of that use case |
| never mention it, though the code needs it to carry out a decision | nothing of its own: part of the effects of the use case it serves, or left to the code |
| name the record and its facts | an entity and its fields, `core` or `supporting` |
| never mention it, though it is stored | an entity or field marked `internal` |

Three consequences:

- **Reachable is not the test, deciding is.** A function that only other code calls is not a use case, and neither is a function a generic admin console happens to expose. A use case decides something: it changes what is true for the business, such as a quote that is now sent, accepted or expired.
- **One actor, many doors.** The same person reaching the same use case through a page, an API key or an MCP tool is one actor and one use case, exposed by several interfaces.
- **Data is kept, behavior is chosen.** All persisted data is in the model, classified by relevance (2.1), because the data is a fact. Behavior is in the model only when it passes the test above.

### 8.2 What the language contains

The model says what the business decides: what exists, what may happen, who may do it, what must hold and what follows from what. It does not say how the code does it. The language stays small enough that a person or an AI reads all of it, so every construct has to earn its place.

A construct belongs in the language only when all three hold:

1. **A domain expert states it.** "A draft expires after 30 days" and "personal data is kept seven years" are business decisions; the wording of a confirmation email is not.
2. **It changes what the business allows or what happens**, not how the code does it.
3. **The validator or the simulator uses it.** Something only a generator reads belongs in the target's options in `appling.config.json`, or in the generated code.

What fails the test goes elsewhere:

| Concern | Where it goes |
|---|---|
| How to call an external system: base URL, paths, request mapping, credentials | the system's own contract, such as an OpenAPI file, or the generated client |
| Stacks, repositories, deployment, infrastructure, environments | `appling.config.json` and the project itself |
| Notifications: channels, recipients, subjects and texts | the generated code |
| Seed and demo data | the generated project |
| Message templates, styling, the visual design system | the generated code |
| Performance, scaling and SLAs | out of scope |

Code generation produces a draft, not a runtime. A registry task is either a **generator gap**, something the model says that the generator does not produce yet, or work the model **leaves to the code** by this section. Only generator gaps lower the codegen coverage; closing them is the generators' job, not the language's. A missing business fact never shows up as a task, because a generator only sees what the model says: it shows up as a scenario the model cannot express, or a question the simulator cannot answer.

Before a new construct is added, the language reference the AI reads (`docs/language/`) is checked against its size budget, and `scripts/bench/ai-modeling.mjs` measures whether an assistant that knows only that reference still writes valid models from a business brief.

## 9. Guiding Philosophy

**Define once. Reference outward. Validate always. Visualize at any level.**

The application model describes what exists, what can happen, how capabilities are organized and exposed, and how people interact with them.

The text is the canonical form. The AST and semantic graph are its structure. The visualization is an interactive projection. AI is another editor of that same model, bound by the same rules.
