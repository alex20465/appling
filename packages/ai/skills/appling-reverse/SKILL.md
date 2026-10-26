---
name: appling-reverse
description: Derive an Appling model from an existing application (Django, Ash, Rails, Spring, Express, or any codebase with a data model): its entities, behavior, queries, interfaces and pages, written as validated .appling files. Use when asked to reverse engineer, extract, document or model an existing application in Appling. Needs the Appling MCP server (appling-mcp) pointed at the folder for the model.
---

# Deriving an Appling model from an existing application

The goal is a model that says what the application already does, in the five Appling layers, and that validates. The code is the source of truth; the model describes it and never invents behavior.

## 1. Survey

Find where the application keeps each kind of knowledge before writing anything:

| Look for | Typical places |
|---|---|
| Data model | ORM models, schema files, migrations (`models.py`, Ash resources, `schema.rb`, JPA entities, Prisma schema) |
| Allowed values | enum types, `choices`, check constraints |
| Rules | validations, constraints, `clean()` methods, model callbacks |
| Behavior | service functions, commands, state fields with transition code, signals and events, scheduled jobs |
| Reads | query methods, scopes, repositories, serializers and DTOs |
| Access | permission classes, policies, guards, role checks |
| Interfaces | routes, controllers, API views, GraphQL schemas |
| Pages | templates, views, front end routes, navigation |

Group what you find into modules by bounded context: the apps, packages or domains the code already has.

## 2. Map to Appling

| Found in code | Appling |
|---|---|
| table or model with identity | `entity` with fields; references to other models as fields of that entity type |
| embedded or JSON structure without identity | `value` |
| fixed set of values | `enum` |
| constraint that must always hold | `invariant` |
| state field changed by specific operations | a `state` field and a `machine` with one `transition` per operation |
| operation that changes data | `action on <Entity>` with `input`, `requires ... else <Error>`, `effect` and `errors` |
| domain event or signal | `event`, emitted by the action that sends it |
| scheduled or triggered job | `job ... every "<cron>" run <Action>` or `on <Event>` |
| reusable read | `query from <Entity>` with `where`, `sort` and `paginate` |
| serializer or DTO | `projection` |
| call to another system | `external` with typed `op`s |
| multi step process | `usecase` with `step`s and error handlers |
| API routes | `interface rest` with endpoints |
| screens | `page` with `list`, `detail` and `form`; menus as `navigation` |
| permission check | `policy` on the entity, action, query or use case it protects |

Access needs the most care, because a policy that reads well can still let the wrong actor through:

- **Grant by role.** Every policy is a list of grants, one per role: `actor.is(Role)`, followed by `&&` and the conditions that role must meet, such as `actor.is(Admin) || (actor.is(PropertyOperator) && account == actor.account)`. Name roles, not actors, so the policy says what kind of principal may act. Never write `{ true }`, a policy without any role, or a negative check such as `!actor.is(Role) || ...`: each of them lets in every role nobody thought about, including unauthenticated visitors. A role that no policy names may do nothing, and the simulator must show exactly that.
- **Give every principal a role.** Signed in people, API clients, the unauthenticated visitor (only what a public route reaches), external callers such as webhooks, and the code that runs without an actor or skips authorization (`authorize?: false`, `skip_authorization`, jobs, reactors, seeds) each become an actor with a role, such as `actor system Worker roles Background`.
- **Take the grants from the call sites.** An operation whose resource checks nothing is not open: the routes, live sessions, controllers, jobs and admin consoles that reach it decide who runs it. Find every call site and grant the roles of the principals they let through, with a `//` comment naming the call sites. When nothing reaches an operation, write `policy delete { false }` (or the operation at hand) so nobody may.
- **Guard actor fields by role.** `actor.operator` is null for every actor that does not declare `operator`, so read it only inside the grant of the role that has it: `actor.is(PropertyOperator) && actor.operator.archived_at == null`.
- **Write ownership as a condition of the grant**, such as `actor.is(PropertyOperator) && this == actor.operator` for self service on an operator record.
- **Follow nested writes.** When an operation also creates or updates related records (nested forms, `manage_relationship`, cascading saves), add those writes to the action's `effect`, so the policies of the related entities apply too.

Keep each concept in the layer that owns it, reference other modules only through what they `export`, and write expressions in Appling's CEL subset. Appling is a new language, so do not write it from memory: call `language_reference` for the list of pages, read `overview` first, then the page of each layer before you write it (`domain`, `behavior`, `application`, `interfaces`, `experience`, `access`, `expressions`, `modules`, `relevance`).

Mark what the business runs on with a relevance level (`language_reference` page `relevance`), so people looking at the model see the core first. The graph already ranks declarations by how much uses them and how much they use; declare a level only where that ranking misses the business:

- `core` on the records the product exists for and the actions, machines and use cases that carry its main process, such as the quote, sending and accepting it, and the reservation it books. Judge from what the code puts first: the main routes and screens, the state machine of the central record, what the product's name and landing page are about.
- `peripheral` on whole modules of housekeeping, such as audit and event logs, one shot imports and migrations, chat or assistant add ons, metrics, and on internal tokens and records nobody outside their module reads.
- Leave `supporting` and everything else to the graph unless a module clearly sits between the two.

Declare a level on the module when all of it shares it, on the declaration otherwise, and keep `core` to a few declarations per module: when everything is core, nothing stands out.

## 3. Write and validate

1. Write one module per file with `write_model_file`, starting with the domain layer: enums, value types, entities. It refuses a file that introduces errors and tells you why.
2. Call `check` after each file. Fix errors before moving on; never leave the model invalid.
3. Add behavior, then application, interfaces and pages, module by module. Use `edit` for small changes to files that exist.
4. For each element you write, call `record_code_references` with the line ranges of the code it describes, each starting at the line that declares it (the model class, the function, the permission class). Paths are absolute or relative to the model folder.
5. Use `graph_query` to confirm references, and `simulate` to compare the model's behavior with the code: can each state be reached the way the code reaches it, and do the right actors pass the policies? Ask `simulate` with `question: "actors"` for each action, and check every `yes` for an anonymous or low privileged actor: each one must have a place in the code that allows it.

## 4. Report what is uncertain

When the code does something the model cannot say exactly (a rule spread over several functions, dynamic permissions, raw SQL), model the closest correct form, put a `//` comment above it that names the source file, and list it in your summary. Name what you left out on purpose and why, and which declarations you marked `core` or `peripheral` and on what evidence. Do not guess intentions: if two readings of the code are possible, ask.
