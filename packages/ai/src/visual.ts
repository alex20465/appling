import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { EditOperation } from '@appling/model';
import type { Visualizer } from '@appling/viz';
import { VIEW_KINDS, type ViewKind } from '@appling/viz/views';
import { proposal } from './chat.js';
import { define, operationSchema, ProposalContext, type Tools } from './tools.js';

/** What the visual tools need from the window, so tests can stand in for Electron. */
export type VisualHost = Pick<Visualizer, 'show' | 'bubble' | 'selection' | 'reply' | 'review' | 'onAsk'>;

const VIEWS = Object.keys(VIEW_KINDS) as [ViewKind, ...ViewKind[]];

export const VISUAL_INSTRUCTIONS = `The appling server can show the model in a floating window next to the terminal. Use it when the person asks to see, show, draw or visualize part of the model, and also when they ask how a part of the application works, such as "how does observability work": find the elements involved with the model tools, show them with visualize and explain them in the window with visual_bubble, besides a short answer in the terminal. Pick the view that fits: node (one declaration or module in the model tree with what uses it), machine (a flowchart of the states and the transitions between them), action (between which states it moves, who may run it, what it requires and changes), usecase (a flowchart of the steps), event (who emits and consumes it).

To walk the person through the model, show one node at a time: each node view adds the element to the tree on screen and unfolds it in place, so show next one of the elements that use it. Explain what happens at an element with visual_bubble, one bubble per step in the order of the explanation; the window shows one bubble at a time and numbers them, so the person steps through them. Pass code, file and line to hint how an element is implemented, such as from code_references.

While the window is open, read what the person clicked with visual_selection when they say "this" or "the selected one", and change the model with propose_edits instead of edit so they can review the change in the window.

Questions typed into the window arrive as <channel source="appling" ask_id="..." selected="..." view="...">. Look things up with the model tools, then answer with visual_reply, passing the ask_id; the answer appears in the window, not in the terminal.`;

/** Tools that drive the floating window. Only the MCP server registers them. */
export function visualTools(host: VisualHost): Tools {
    return {
        visualize: define({
            description: 'Show a view of the model in the floating window next to the terminal, opening it when needed. Use it when the person asks to see or visualize something or asks how a part of the application works. view: node (any declaration or module; adds it to the tree on screen and unfolds what uses it, so you can guide one node at a time), machine (machines, as a flowchart), action (actions), usecase (use cases, as a flowchart), event (events). The person can click elements, ask questions from the window and jump to related elements.',
            input: {
                view: z.enum(VIEWS),
                focus: z.array(z.string()).min(1).describe('Qualified names of the elements to draw, such as ["sales.OrderFlow"]'),
                title: z.string().optional().describe('A short title for the window'),
                note: z.string().optional().describe('One or two sentences about what the view shows')
            },
            run: async (context, input) => {
                const graph = await context.project.graph(context.sources());
                const kinds = new Map(graph.nodes.map(n => [n.qn, n.kind]));
                const wrong = input.focus.filter(qn => !VIEW_KINDS[input.view].includes(kinds.get(qn) ?? ''));
                if (wrong.length) return { error: `The ${input.view} view draws ${VIEW_KINDS[input.view].join(' or ')} elements; not: ${wrong.map(qn => kinds.has(qn) ? `${qn} (${kinds.get(qn)})` : `${qn} (no such element)`).join(', ')}.` };
                await host.show({ view: input.view, focus: input.focus, title: input.title, note: input.note });
                return { shown: true };
            }
        }),
        visual_bubble: define({
            description: 'Place a bubble on an element of the view in the floating window, or on one of its members such as a field, to say what happens there. With code: a short example that hints how the element is implemented, with the file (relative to the model folder) and line it comes from. The bubbles stay until a different view is shown.',
            input: {
                target: z.string().describe('Qualified name of the element or member, such as "sales.Order.status"'),
                text: z.string().describe('One or two sentences'),
                code: z.string().optional().describe('A few lines of code'),
                file: z.string().optional().describe('The file the code is in, relative to the model folder'),
                line: z.number().int().min(1).optional().describe('The line in the file')
            },
            run: async (context, input) => {
                const graph = await context.project.graph(context.sources());
                if (!graph.nodes.some(n => n.qn === input.target)) return { placed: false, reason: `No element ${input.target}.` };
                if (input.line && !input.file) return { placed: false, reason: 'A line needs its file.' };
                if (input.file && !existsSync(resolve(context.project.root, input.file))) return { placed: false, reason: `No file ${input.file} relative to the model folder.` };
                return host.bubble(input) ? { placed: true } : { placed: false, reason: 'The window is closed.' };
            }
        }),
        visual_selection: define({
            description: 'What the person selected in the floating window: the qualified name of the clicked element and the view on screen. open is false when the window is closed.',
            input: {},
            run: async () => host.selection()
        }),
        visual_reply: define({
            description: 'Answer a question the person typed into the floating window; the text appears there. Pass the ask_id of the channel message.',
            input: { text: z.string(), ask_id: z.string().optional() },
            run: async (_, input) => (host.reply(input.text, input.ask_id) ? { sent: true } : { sent: false, reason: 'The window is closed.' })
        }),
        propose_edits: define({
            description: 'Propose model changes for the person to review in the floating window: the operations are validated on a copy, shown as text and graph differences, and written only when the person accepts. Waits for the decision and returns it, with their comment when they reject.',
            input: { operations: z.array(operationSchema).min(1), summary: z.string().describe('What changes and why, in one or two sentences') },
            run: async (context, input) => {
                const working = new ProposalContext(context.project, context.sources());
                for (const operation of input.operations as EditOperation[]) {
                    const result = await working.edit(operation, false);
                    if (!result.ok) return { ok: false, operation, errors: result.errors };
                }
                const { hunks, graph } = await proposal(context.project, working);
                const decision = await host.review({ summary: input.summary, hunks, graph });
                if (!decision.accepted) return { accepted: false, comment: decision.comment };
                const changed = new Set<string>();
                for (const operation of working.operations) {
                    const result = await context.edit(operation, false);
                    if (!result.ok) return { accepted: true, ok: false, operation, errors: result.errors };
                    result.changed?.forEach(file => changed.add(file));
                }
                return { accepted: true, ok: true, changed: [...changed] };
            }
        })
    };
}
