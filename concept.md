# Appling: Declarative Application Modeling DSL (v2)

## 1. Vision

*Appling: grow your app from one seed.*

Create a declarative Domain-Specific Language (DSL) that describes the structural and behavioral model of a business or web application.

The model is the **single source of truth**. It has a canonical text syntax that round-trips losslessly to an Abstract Syntax Tree (AST). After reference resolution, the AST becomes a semantic graph. All tools (visualization, AI, validation) work on that graph.

The primary goal is an **interactive, zoomable visualization** that both humans and AI can explore, construct, and modify, backed by a model that can be **validated structurally and simulated behaviorally**. Code generation is a possible future feature.

**Differentiator:** layered application modeling exists already (WebML/IFML, MDA, Ash, Mendix). This project's distinct contribution is AI-native editing plus semantic-zoom exploration of one validated model.

## 2. Model Structure

### 2.1 Cross-cutting concepts

These are not layers. They apply across all layers.

**Modules (bounded contexts)**
- Every model element belongs to exactly one module.
- Modules may contain sub-modules and form the containment hierarchy used by semantic zoom.
- Cross-module references must go through elements the target module explicitly exports.

**Identity and access**
- Actors (human users, systems, services), roles, and tenants.
- Each policy, wherever it is defined, refers to these concepts.
- The current actor and tenant are always available in the expression context.

**Expression language**
- A small, typed, side-effect-free language used for constraints, policies, guards, derived fields, and filters.
- It has defined semantics, so it can be evaluated by the validator and the simulator.

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

Describes what can happen to the data and how it changes.

- Actions: CRUD and custom, each with input, **preconditions**, effects, and declared errors.
- State machines: own the transitions over a Layer 1 state field. Each transition has guards and effects, and is triggered by actions or events.
- Events (domain events emitted by actions or transitions)
- Jobs: asynchronous or scheduled execution of actions
- Transaction / consistency boundary per action
- Action-level access policies

Rule of placement: something that must always be true belongs in Layer 1 as an invariant. Something that must be true for an action to run belongs in Layer 2 as a precondition.

#### Layer 3 — Application

Describes how domain capabilities are organized for practical use.

- **Queries:** filtered, sorted, paginated access to entities. They inherit entity policies.
- **Projections** (renamed from "views of data"): shaped read models over entities and queries. This is the **only** place where a shape may diverge from the entity, for example API versions or DTOs.
- **Use cases:** the single process concept. A use case orchestrates actions, queries, and events into an application-level operation, and may be long-running.
- External systems: consumed integrations declared as dependencies with typed operations.
- Query- and use-case-level access policies

#### Layer 4 — Interfaces / Transport

Describes how application capabilities are exposed to non-human or programmatic consumers.

- REST APIs, GraphQL schemas, MCP interfaces, webhooks, other protocols
- Mapping from endpoints to use cases, queries, actions, and projections
- Transport-specific policies: auth scheme, rate limits, CORS. These may only add restrictions.

Web routes for human-facing pages are owned by Layer 5, not Layer 4.

#### Layer 5 — User Experience

Describes what humans can see and interact with.

- Navigation and menu structures
- Pages with their routes/URLs
- Forms, lists, detail views, bound to actions, queries, and projections
- User-facing workflows, which reference Layer 3 use cases and do not redefine process logic
- Presentation, interaction, and i18n (localized labels and messages)

Not every entity or action must be exposed through an interface or a user interface.

### 2.3 Reference rules

Allowed references form a directed acyclic graph:

| From | May reference |
|---|---|
| L2 Behavior | L1 |
| L3 Application | L1, L2 |
| L4 Interfaces | L1 (types only), L3, L2 actions |
| L5 Experience | L1 (types only), L2 actions, L3 |
| Any layer | Cross-cutting concepts |

- L4 and L5 are siblings, and neither references the other.
- Lower layers never reference higher layers.
- The validator rejects any other edge.

## 3. Core Design Principles

**Single source of truth:** Each concept is defined once, in its owning layer, and referenced everywhere else.

**Bottom-up inheritance with monotonic narrowing:** Higher layers inherit definitions, constraints, and policies from lower layers. They may only narrow them, by exposing fewer fields or applying stricter policies. They may never widen them. Intentional divergence of shape happens only through Layer 3 projections.

**Local policies:** Access policies are defined next to the concepts they protect: entities, actions, queries, and use cases. The effective policy at any point is the conjunction of all policies along the reference path.

**Explicit exposure:** Interfaces, navigation, pages, and module exports are intentionally declared, never derived from the mere existence of entities.

**Separation of concerns:** Domain behavior is independent of its presentation or transport.

**Extensibility through extensions:** New capabilities, such as a protocol, a UI pattern, or a data type, are added as extensions. An extension contributes new element kinds, their validation rules, and their visualization, without changes to the core.

## 4. Interactive Visualization

The model is visualized as a connected, multidimensional graph with **semantic zoom**.

- **Zoomed out:** modules, their dependencies, and major use cases
- **Medium zoom:** entities, relationships, actions, state machines, queries, projections, interfaces, and pages
- **Zoomed in:** fields, invariants, policies, guards, expressions, and errors

Rules:

- The graph is a projection of the semantic graph, not a separate source of truth.
- Zoom levels follow the module containment hierarchy. Aggregated nodes and edges, such as module-to-module dependencies, are computed from the model, never drawn by hand.
- Every model element is identified by its **qualified name**, such as `sales.Order.status`, so graph edits map back to exact AST nodes. Renames are recorded as migration steps, so tools can follow an element to its new name.
- Layout and view state (positions, collapsed groups, saved views) are stored **separately** from the model. They are not part of the truth and do not appear in model diffs.

## 5. Validation and Simulation

**Structural validation (always on):**
- References resolve
- Types match
- Reference rules (2.3) hold
- Narrowing rule holds
- Each concept has one owner

**Behavioral simulation (initial scope):**
- Evaluates expressions, action preconditions and effects, and state machine transitions against sample data and actors.
- Answers questions such as "Can an order reach Paid?", "Which actors can trigger Cancel?", and "Which invariants does this action risk violating?"

Production runtime remains out of scope. The simulator is the minimum that makes behavior verifiable.

## 6. AI Integration

AI acts as a participant in the modeling process.

It should be capable of:
- Constructing and modifying the model through the canonical text syntax or equivalent AST operations
- Creating entities, actions, rules, use cases, and interfaces
- Understanding relationships and dependencies through the semantic graph
- Explaining behavior, using the simulator rather than guessing
- Proposing changes and identifying inconsistencies

AI-generated changes pass the same structural validation as human edits, and are presented as reviewable diffs.

## 7. Model Evolution

- The model is versioned with its text representation, for example in git.
- Changes to Layer 1 that affect persisted data, such as renames, type changes, or removals, are recorded as explicit migration steps in the model.
- Migration steps target elements by their qualified name as it was before the step, so layout and history can follow renames.

## 8. Out of Scope (initial)

- Production runtime
- Deployment, infrastructure, environments
- Performance, scaling, and SLAs
- Visual design system and styling details

## 9. Guiding Philosophy

**Define once. Reference outward. Validate always. Visualize at any level.**

The application model describes what exists, what can happen, how capabilities are organized and exposed, and how people interact with them.

The text is the canonical form. The AST and semantic graph are its structure. The visualization is an interactive projection. AI is another editor of that same model, bound by the same rules.
