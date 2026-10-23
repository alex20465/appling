import { z } from 'zod';
import { Simulator, UNKNOWN, type EditOperation } from '@appling/model';
import { Project, queryGraph, type Sources } from './project.js';
import { languageReference } from './prompts.js';

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
    simulate: define({
        description: 'Ask the simulator about behavior instead of guessing. reach: the shortest path of transitions from the initial state of a machine to a state. actors: for every actor whether it may trigger an action (yes, no, or depends on the data). risks: the invariants an action may violate through the fields it changes. run: run an action on a sample record as an actor, with inputs, and see policies, preconditions, the transition, effects, events and violated invariants.',
        input: {
            question: z.enum(['reach', 'actors', 'risks', 'run']),
            machine: z.string().optional().describe('reach: qualified name of the machine'),
            state: z.string().optional().describe('reach: the target state'),
            action: z.string().optional().describe('actors, risks, run: qualified name of the action'),
            record: z.record(z.string(), z.unknown()).optional().describe('run: field values of the record, such as {"status": "draft", "lines": []}'),
            actor: z.string().optional().describe('run: qualified name of the actor'),
            actorFields: z.record(z.string(), z.unknown()).optional(),
            inputs: z.record(z.string(), z.unknown()).optional()
        },
        run: async (context, input) => {
            const simulator = new Simulator(await context.project.graph(context.sources()));
            try {
                const answer = input.question === 'reach' ? simulator.reach(input.machine ?? '', input.state ?? '') ?? { reachable: false }
                    : input.question === 'actors' ? simulator.actors(input.action ?? '')
                    : input.question === 'risks' ? simulator.risks(input.action ?? '')
                    : simulator.run(input.action ?? '', input.record as never ?? {}, { actor: input.actor ?? '', fields: input.actorFields as never }, input.inputs as never);
                return JSON.parse(JSON.stringify(answer, (_, value) => (value === UNKNOWN ? 'unknown' : value)));
            } catch (error) {
                return { error: (error as Error).message };
            }
        }
    }),
    edit: define({
        description: 'Change the model with one edit operation. The edit is validated: it is rejected with the errors when it does not parse or introduces errors. Renames follow every reference. With dryRun, only checks it.',
        input: { operation: operationSchema, dryRun: z.boolean().optional() },
        run: (context, input) => context.edit(input.operation as EditOperation, input.dryRun ?? false)
    })
};

/** Tools for writing a model from scratch, such as when deriving it from an existing application. */
export const AUTHORING_TOOLS = {
    language_reference: define({
        description: 'The complete Appling language documentation: syntax, every keyword of the five layers, expressions, access, modules, migrations and the validation rules, with examples. Without page: the list of pages with their titles and descriptions. With page: that page as Markdown. Read overview first, then the pages for what you write, before writing or editing Appling source.',
        input: { page: z.string().optional().describe('Page name from the list, such as overview, domain or expressions') },
        run: async (_, input) => languageReference(input.page)
    }),
    write_model_file: define({
        description: 'Create or replace one .appling file of the workspace, such as a new module. The file is written only when the whole workspace still validates with it; otherwise the errors come back. Paths are relative to the workspace folder.',
        input: { path: z.string().describe('Relative path ending in .appling, such as sales/sales.appling'), source: z.string().describe('The complete Appling source of the file') },
        run: async (context, input) => context.project.writeModelFile(input.path, input.source)
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
