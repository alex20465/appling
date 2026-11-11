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

/** Sent to every MCP client: where business logic lives, so assistants ask the model before they search the code. */
export const MCP_INSTRUCTIONS = `This server serves the Appling model of the application: its domain (entities, fields, invariants, policies), behavior (actions, state machines, events, jobs), application layer (queries, projections, external systems, use cases), interfaces and pages, with roles and actors.

The model is the source of truth for business logic. For any question about what the application does or allows (rules, states and their transitions, which actions exist, who may run them, what an action requires and changes, permissions, flows, the shape of the data), answer from the model first: find elements with graph_query, read them with read_source and ask simulate about behavior instead of reasoning it out. Read the application code only for how something is implemented or when the model does not cover it, and say so when the code and the model disagree. code_references tells where an element is implemented, by file and line range. request_next hands out the elements the person asked for on the canvas by name and description only; model each and close it with request_done.`;
