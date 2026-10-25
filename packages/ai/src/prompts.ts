import { readdirSync, readFileSync } from 'node:fs';

/** A skill's instructions without its frontmatter: the one source for the skill and its MCP prompt. */
function skill(name: string): string {
    return readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8').replace(/^---[\s\S]*?---\n+/, '');
}

export const REGISTRY_PROMPT = skill('appling-registry');

export const REVERSE_PROMPT = skill('appling-reverse');

/** The language documentation, copied from the repository's docs/language at build time. */
const LANGUAGE = new URL('../language/', import.meta.url);

/** Without a page: every page with its title and description. With one: its Markdown. */
export function languageReference(page?: string): unknown {
    const pages = readdirSync(LANGUAGE).filter(file => file.endsWith('.md')).map(file => file.slice(0, -3));
    const text = (name: string) => readFileSync(new URL(`${name}.md`, LANGUAGE), 'utf8');
    if (page === undefined) {
        return { pages: pages.map(name => ({ page: name, ...Object.fromEntries([...text(name).matchAll(/^(title|description): (.*)$/gm)].map(m => [m[1], m[2]])) })) };
    }
    return pages.includes(page) ? { page, markdown: text(page) } : { error: `No page ${page}. Pages: ${pages.join(', ')}.` };
}

export const CHAT_SYSTEM = `You help people model their application in Appling, a declarative language that describes a business application in five layers: domain (entities, value types, enums, invariants, policies), behavior (actions, state machines, events, jobs), application (queries, projections, external systems, use cases), interfaces and experience (pages). Cross cutting: modules, roles, actors, tenants, migrations.

Answer from the model itself: use graph_query and read_source to look things up before you explain or change anything. Change the model only with the edit tool, one operation at a time; every edit is validated, and a rejected edit comes back with the errors to fix. Your edits are collected as a proposal that the person reviews and accepts in the IDE, so describe what you changed and why in a few sentences when you are done. Keep each concept in the layer that owns it, and reference across modules only what a module exports.`;

/** Sent to every MCP client: where business logic lives, so assistants ask the model before they search the code. */
export const MCP_INSTRUCTIONS = `This server serves the Appling model of the application: its domain (entities, fields, invariants, policies), behavior (actions, state machines, events, jobs), application layer (queries, projections, external systems, use cases), interfaces and pages, with roles and actors.

The model is the source of truth for business logic. For any question about what the application does or allows (rules, states and their transitions, which actions exist, who may run them, what an action requires and changes, permissions, flows, the shape of the data), answer from the model first: find elements with graph_query, read them with read_source and ask simulate about behavior instead of reasoning it out. Read the application code only for how something is implemented or when the model does not cover it, and say so when the code and the model disagree.`;
