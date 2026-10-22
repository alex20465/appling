import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { stepCountIs, streamText, tool, type LanguageModel, type ModelMessage } from 'ai';
import { URI } from 'langium';
import { z } from 'zod';
import type { EditOperation, Graph } from '@appling/model';
import { Project, type Sources } from './project.js';
import { CHAT_SYSTEM } from './prompts.js';
import { MODEL_TOOLS, ProposalContext, type ToolContext, type Tools } from './tools.js';

export interface ModelSettings {
    provider: 'anthropic' | 'openai';
    model: string;
}

export const DEFAULT_MODEL: ModelSettings = { provider: 'anthropic', model: 'claude-opus-5-5' };

/** The `ai` section of `appling.config.json`, such as `{ "provider": "openai", "model": "..." }`. API keys come from the environment. */
export function modelSettings(root: string): ModelSettings {
    const file = join(root, 'appling.config.json');
    const ai = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { ai?: Partial<ModelSettings> }).ai : undefined;
    return { ...DEFAULT_MODEL, ...ai };
}

export function languageModel(settings: ModelSettings): LanguageModel {
    return settings.provider === 'openai' ? createOpenAI()(settings.model) : createAnthropic()(settings.model);
}

export interface Hunk {
    file: string;
    line: number;
    removed: string[];
    added: string[];
}

export interface Proposal {
    operations: EditOperation[];
    hunks: Hunk[];
    graph: { added: string[], removed: string[], changed: string[] };
}

export type ChatEvent =
    | { type: 'text', text: string }
    | { type: 'tool', name: string, input: unknown }
    | { type: 'proposal', proposal: Proposal }
    | { type: 'error', message: string };

/**
 * One chat turn about the model. Edits go to a working copy; when the turn ends they come back as a
 * proposal with text and graph differences, for a person to accept or reject.
 */
export async function* chat(root: string, messages: ModelMessage[], model: LanguageModel): AsyncGenerator<ChatEvent> {
    const project = new Project(root);
    const context = new ProposalContext(project);
    try {
        const result = streamText({ model, system: CHAT_SYSTEM, messages, tools: aiTools(MODEL_TOOLS, context), stopWhen: stepCountIs(25) });
        for await (const part of result.fullStream) {
            if (part.type === 'text-delta') yield { type: 'text', text: part.text };
            else if (part.type === 'tool-call') yield { type: 'tool', name: part.toolName, input: part.input };
            else if (part.type === 'error') yield { type: 'error', message: String(part.error) };
        }
    } catch (error) {
        yield { type: 'error', message: (error as Error).message };
    }
    if (context.operations.length) yield { type: 'proposal', proposal: await proposal(project, context) };
}

function aiTools(tools: Tools, context: ToolContext) {
    return Object.fromEntries(Object.entries(tools).map(([name, definition]) => [name, tool({
        description: definition.description,
        inputSchema: z.object(definition.input),
        execute: (input: Record<string, unknown>) => definition.run(context, input)
    })]));
}

async function proposal(project: Project, context: ProposalContext): Promise<Proposal> {
    const [before, after] = [await project.graph(context.original), await project.graph(context.sources())];
    return { operations: context.operations, hunks: hunks(project.root, context.original, context.sources()), graph: graphDiff(before, after) };
}

/** One hunk per changed file, from the first to the last changed line. */
export function hunks(root: string, before: Sources, after: Sources): Hunk[] {
    return Object.keys(after).filter(uri => before[uri] !== after[uri]).map(uri => {
        const [a, b] = [(before[uri] ?? '').split('\n'), after[uri].split('\n')];
        let start = 0;
        while (start < a.length && start < b.length && a[start] === b[start]) start++;
        let end = 0;
        while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
        return { file: relative(root, URI.parse(uri).fsPath), line: start + 1, removed: a.slice(start, a.length - end), added: b.slice(start, b.length - end) };
    });
}

export function graphDiff(before: Graph, after: Graph): Proposal['graph'] {
    const old = new Map(before.nodes.map(n => [n.qn, JSON.stringify(n.props)]));
    const next = new Map(after.nodes.map(n => [n.qn, JSON.stringify(n.props)]));
    return {
        added: [...next.keys()].filter(qn => !old.has(qn)),
        removed: [...old.keys()].filter(qn => !next.has(qn)),
        changed: [...next.keys()].filter(qn => old.has(qn) && old.get(qn) !== next.get(qn))
    };
}
