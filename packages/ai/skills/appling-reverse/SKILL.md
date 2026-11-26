---
name: appling-reverse
description: Derive an Appling model from an existing application (Django, Ash, Rails, Spring, Express, or any codebase with a data model): its entities, behavior, queries, interfaces and pages, written as validated .appling files. Use when asked to reverse engineer, extract, document or model an existing application in Appling. Needs the Appling MCP server (appling-mcp) pointed at the folder for the model.
---

# Deriving an Appling model from an existing application

The goal is a model of the business logic the way a domain expert sees, understands and describes it, in the five Appling layers, and that validates. The code is the evidence; the model is an abstraction of it, never a one to one copy, and never invents behavior. What only the code needs to carry out a decision stays in the code.

## 1. Survey

Find where the application keeps each kind of knowledge before writing anything:

| Look for | Typical places |
|---|---|
| Who uses it | sign up and login, user types, permission classes, the audiences of the screens and of the API documentation |
| What they can start | routes, screens, buttons, forms, API endpoints, incoming webhooks, schedules |
| Data model | ORM models, schema files, migrations (`models.py`, Ash resources, `schema.rb`, JPA entities, Prisma schema) |
| Allowed values | enum types, `choices`, check constraints |
| Rules | validations, constraints, `clean()` methods, model callbacks |
| Reads | query methods, scopes, repositories, serializers and DTOs |
| Pages | templates, views, front end routes, navigation |

Start from the outside: the screens, the endpoints and the schedules say what the business does. Service functions, workers and helpers only say how. Group what you find into modules by bounded context: the apps, packages or domains the code already has.

## 2. Decide what belongs

For each thing you find, ask how a domain expert would put it:

| A domain expert would | In the model |
|---|---|
| name who does it | an `actor` |
| say "the operator sends the quote" or "a quote expires after its deadline" | a `usecase` |
| describe what happens inside, in their own words | plain `step "..."` lines of that use case |
| never mention it, though the code needs it to carry out a decision | nothing of its own: an effect of the use case's action, or left out |
| name the record and its facts | an `entity` with fields |
| never mention it, though it is stored | an `entity` or field marked `internal` |

**Actors** are who acts, never how they connect:

- One `actor human` per kind of person or organization that uses the platform, named the way the business names them: `Admin`, `Operator`, `Partner`, `Guest`.
- One `actor thirdparty` per outside system that calls in on its own, named after that system and nothing else: `Webhotelier`, never `WebhotelierWebhook`.
- Exactly one `actor system System` for everything the application does on its own: schedules, workers, queues, reactors, and code that skips authorization. Never `Worker`, `Background` or the name of a job library.
- A session, an API key, a token or a webhook signature is a credential, so it is the `auth` of an `interface` and never an actor. An operator calling the API with a key is the same `Operator`.
- Declare a `role` only where one actor holds different business permissions, such as an `Operator` who is also `Manager`. An actor needs no role, and a role never restates an actor.

**Use cases** are the only way in. One use case is one thing an actor starts that decides something for the business:

- The test is deciding, not being callable. A function that changes what is true for the business (a quote is now sent, accepted, expired) is a use case. A function that sets a field, stores a link, retries, logs, renders or completes a transition supports a decision: fold it into the effects of the use case it serves, or leave it out. Setting the payment URL of an offer supports accepting a quote; it decides nothing.
- What only other code calls is never a use case of its own, and neither is what only a generic admin console exposes.
- The same decision reached through a page, an API and an MCP tool is one use case with several interfaces.
- Every use case names who starts it in its head: `usecase SendQuote (quote: Quote) by Operator`, with a comma for several actors. That is its permission; add a `policy` only for a condition, such as ownership. A use case nobody starts does not exist.
- Write what happens inside as plain steps in the words of a domain expert: `step "hold the rooms"`, `step "send the proposal to the guest"`. Leave out technical steps.
- The rules and effects of the decision go into one `action` the use case calls with `step Send(quote)`: `input`, `requires ... else <Error>`, `effect`, `errors`, with a policy for the same actors. Write no other actions.

**Data** is kept in full. Every table becomes an `entity`, because the data is a fact; relevance (below) separates the business from the rest.

## 3. Map to Appling

| Found in code | Appling |
|---|---|
| table or model with identity | `entity` with fields; references to other models as fields of that entity type |
| embedded or JSON structure without identity | `value` |
| fixed set of values | `enum` |
| constraint that must always hold | `invariant` |
| state field changed by business decisions | a `state` field and a `machine` with one `transition` per decision |
| domain event the business names | `event`, emitted by the action that sends it |
| schedule or trigger of a business rule | `job ... every "<cron>" run <Action>` or `on <Event>`, its use case started by `System` |
| reusable read an actor sees | `query from <Entity>` with `where`, `sort` and `paginate` |
| the shape an actor sees | `projection` |
| a system this application calls | `external` with typed `op`s |
| API routes | `interface` with its `auth` and endpoints, bound to use cases and queries |
| screens | `page` with `list`, `detail` and `form`; menus as `navigation`, nested the way the routes and the menus of the application nest |
| permission check | `policy` on the entity, use case, action or query it protects |

Access needs care, because a policy that reads well can still let the wrong actor through:

- **Grant by actor.** Every policy is a list of grants: `actor.is(Admin) || (actor.is(Operator) && account == actor.account)`. Never write `{ true }`, a policy that names nobody, or a negative check such as `!actor.is(Guest) || ...`: each lets in everyone nobody thought about. An actor that nothing names may do nothing.
- **Take the grants from what the business allows**, read from the screens, endpoints and schedules that reach the decision. A check the code skips for its own convenience (`authorize?: false`, `skip_authorization`) is `System`, not an open door.
- **Guard actor fields by actor.** `actor.account` is null for every actor that does not declare it, so read it only inside the grant of the actor that has it.
- **Write ownership as a condition of the grant**, such as `actor.is(Operator) && this == actor.operator`.
- **Follow nested writes.** When a decision also creates or updates related records, add those writes to the action's `effect`, so the policies of the related entities apply too.

Keep each concept in the layer that owns it, reference other modules only through what they `export`, and write expressions in Appling's CEL subset. Appling is a new language, so do not write it from memory: call `language_reference` for the list of pages, read `overview` first, then the page of each layer before you write it (`domain`, `behavior`, `application`, `interfaces`, `experience`, `access`, `expressions`, `modules`, `relevance`).

Mark relevance on everything (`language_reference` page `relevance`), judged as a domain expert would, because people look at `core` first and switch the rest on:

- `core` on what they name when they describe the business in a sentence or two: the few records, use cases and machines such as the quote, sending and accepting it, and the reservation it books. Judge from what the application puts first: the main screens, the state machine of the central record, what the product's name and landing page are about. Keep it to a few declarations per module: when everything is core, nothing stands out.
- `supporting` on what the business needs around the core: a table that links two important records, a history or audit log, an enum or value type of a core record.
- `peripheral` on minor business housekeeping, such as one shot imports and metrics.
- `internal` on what no domain expert would name: tables and fields for API keys, tokens, webhook events, job and migration state.
- Never `core` on what only surrounds a core record, however much uses it.

Declare a level on the module when all of it shares it, on the declaration otherwise.

## 4. Write and validate

1. Write one module per file with `write_model_file`, starting with the domain layer: enums, value types, entities. It refuses a file that introduces errors and tells you why. Add a `describe` text only where the code holds knowledge the structure cannot carry, such as the vendor endpoint an operation calls or the format of an id; never restate what names, types and effects already say. Add `does` only to an event, action, machine or job, for work in its code that the model cannot state.
2. Call `check` after each file. Fix errors before moving on; never leave the model invalid.
3. Add behavior, then application, interfaces and pages, module by module. Use `edit` for small changes to files that exist.
4. For each element you write, call `record_code_references` with the line of each declaration it describes (the model class, the function, the permission class); it writes an `@appling` marker comment above each. Paths are absolute or relative to the model folder.
5. Use `graph_query` to confirm references, and `simulate` to compare the model's behavior with the code: can each state be reached the way the code reaches it, and do the right actors pass the policies? Ask `simulate` with `question: "actors"` for each action, and check every `yes` for an anonymous or low privileged actor: each one must have a place in the code that allows it.

## 5. Report what is uncertain

When the code does something the model cannot say exactly (a rule spread over several functions, dynamic permissions, raw SQL), model the closest correct form, put a `//` comment above it that names the source file, and list it in your summary. Name what you left out on purpose and why, and which declarations you marked `core`, `peripheral` or `internal` and on what evidence. Do not guess intentions: if two readings of the code are possible, ask.
