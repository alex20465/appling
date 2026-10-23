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

Keep each concept in the layer that owns it, reference other modules only through what they `export`, and write expressions in Appling's CEL subset. Appling is a new language, so do not write it from memory: call `language_reference` for the list of pages, read `overview` first, then the page of each layer before you write it (`domain`, `behavior`, `application`, `interfaces`, `experience`, `access`, `expressions`, `modules`).

## 3. Write and validate

1. Write one module per file with `write_model_file`, starting with the domain layer: enums, value types, entities. It refuses a file that introduces errors and tells you why.
2. Call `check` after each file. Fix errors before moving on; never leave the model invalid.
3. Add behavior, then application, interfaces and pages, module by module. Use `edit` for small changes to files that exist.
4. Use `graph_query` to confirm references, and `simulate` to compare the model's behavior with the code: can each state be reached the way the code reaches it, and do the right actors pass the policies?

## 4. Report what is uncertain

When the code does something the model cannot say exactly (a rule spread over several functions, dynamic permissions, raw SQL), model the closest correct form, put a `//` comment above it that names the source file, and list it in your summary. Name what you left out on purpose and why. Do not guess intentions: if two readings of the code are possible, ask.
