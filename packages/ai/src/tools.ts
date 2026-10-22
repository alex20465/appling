import { z } from 'zod';
import type { EditOperation } from '@appling/model';
import { Project, queryGraph, type Sources } from './project.js';

export const operationSchema = z.discriminatedUnion('op', [
    z.object({ op: z.literal('add'), parent: z.string().describe('Qualified name of the element to add to, such as sales.Order'), source: z.string().describe('Appling source of the new member, such as "note: Text?"') }),
    z.object({ op: z.literal('rename'), target: z.string(), name: z.string() }),
    z.object({ op: z.literal('retype'), target: z.string().describe('A field or parameter'), type: z.string().describe('Appling type, such as Money or crm.Account[]') }),
    z.object({ op: z.literal('remove'), target: z.string() }),
    z.object({ op: z.literal('set'), target: z.string(), property: z.string().describe('Property name as shown by graph_query, such as default, condition or modifiers'), value: z.string().describe('Appling source of the value; empty removes the property') })
]);

/**
 * Where tools read and write: the files on disk, or a working copy whose edits are collected
 * as a proposal for a human to review.
 */
export interface ToolContext {
    project: Project;
    sources(): Sources;
    /** Applies an edit; returns why it was rejected, or the changed files. */
    edit(operation: EditOperation, dryRun: boolean): Promise<{ ok: boolean, errors?: string[], changed?: string[] }>;
}

export function diskContext(project: Project): ToolContext {
    return {
        project,
        sources: () => project.sources(),
        async edit(operation, dryRun) {
            const result = await project.edit(operation);
            if (!result.ok) return { ok: false, errors: result.errors };
            const changed = [...new Set(result.edits.map(e => e.uri))];
            return { ok: true, changed: dryRun ? changed : project.write(result.sources) };
        }
    };
}

/** A working copy that collects accepted edits instead of writing them. */
export class ProposalContext implements ToolContext {

    readonly original: Sources;
    readonly operations: EditOperation[] = [];
    private working: Sources;

    constructor(readonly project: Project, sources = project.sources()) {
        this.original = sources;
        this.working = sources;
    }

    sources(): Sources {
        return this.working;
    }

    async edit(operation: EditOperation, dryRun: boolean): Promise<{ ok: boolean, errors?: string[], changed?: string[] }> {
        const result = await this.project.edit(operation, this.working);
        if (!result.ok) return { ok: false, errors: result.errors };
        if (!dryRun) {
            this.working = result.sources;
            this.operations.push(operation);
        }
        return { ok: true, changed: [...new Set(result.edits.map(e => e.uri))] };
    }
}

interface ToolDefinition<SHAPE extends z.ZodRawShape> {
    description: string;
    input: SHAPE;
    run(context: ToolContext, input: z.infer<z.ZodObject<SHAPE>>): Promise<unknown>;
}

function define<SHAPE extends z.ZodRawShape>(definition: ToolDefinition<SHAPE>): ToolDefinition<SHAPE> {
    return definition;
}

/** Tools for working on the model. */
export const MODEL_TOOLS = {
    check: define({
        description: 'Validate the Appling model and list its errors as file:line:column message. An empty list means the model is valid.',
        input: {},
        run: async context => ({ errors: await context.project.check(context.sources()) })
    }),
    graph_query: define({
        description: 'Query the semantic graph. With qn: that element with its properties, members and references in both directions. Without qn: elements filtered by kind (Entity, Field, Action, Query...), module or a search text in the qualified name.',
        input: { qn: z.string().optional(), kind: z.string().optional(), module: z.string().optional(), search: z.string().optional() },
        run: async (context, input) => queryGraph(await context.project.graph(context.sources()), input)
    }),
    read_source: define({
        description: 'Read the Appling source text of one element by its qualified name.',
        input: { qn: z.string() },
        run: async (context, input) => ({ source: await context.project.source(input.qn, context.sources()) ?? `No element ${input.qn}.` })
    }),
    edit: define({
        description: 'Change the model with one edit operation. The edit is validated: it is rejected with the errors when it does not parse or introduces errors. Renames follow every reference. With dryRun, only checks it.',
        input: { operation: operationSchema, dryRun: z.boolean().optional() },
        run: (context, input) => context.edit(input.operation as EditOperation, input.dryRun ?? false)
    })
};

/** Tools for working through the task registry of a generated project. */
export const REGISTRY_TOOLS = {
    registry_next: define({
        description: 'The next open task of a generated project in dependency order: the element, what is missing and its model context (properties and related elements), plus the files that produced it. Returns nothing when every task is done or out of attempts.',
        input: { target: z.string().optional().describe('Output folder of a generate target; default: the first one') },
        run: async (context, input) => context.project.nextTask(input.target) ?? { done: 'No open tasks.' }
    }),
    registry_update: define({
        description: 'Record the outcome of working on a registry entry: done when the work is implemented and the related tests pass, partial with a note otherwise.',
        input: { qn: z.string(), status: z.enum(['done', 'partial', 'todo']), note: z.string().optional(), target: z.string().optional() },
        run: async (context, input) => context.project.updateTask(input.qn, input.status, input.note, input.target) ?? { error: `No registry entry ${input.qn}.` }
    }),
    run_tests: define({
        description: "Run the generated project's tests and return whether they passed with the end of the output.",
        input: { target: z.string().optional() },
        run: async (context, input) => context.project.runTests(input.target) ?? { error: 'No generated project with a test command.' }
    })
};

export type Tools = Record<string, ToolDefinition<z.ZodRawShape>>;
