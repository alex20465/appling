import { z } from 'zod';
import type { EditOperation } from '@appling/model';
import type { Visualizer } from '@appling/viz';
import { VIEW_KINDS, type ViewKind } from '@appling/viz/views';
import { proposal } from './chat.js';
import { define, operationSchema, ProposalContext, type Tools } from './tools.js';

/** What the visual tools need from the window, so tests can stand in for Electron. */
export type VisualHost = Pick<Visualizer, 'show' | 'selection' | 'reply' | 'review' | 'onAsk'>;

const VIEWS = Object.keys(VIEW_KINDS) as [ViewKind, ...ViewKind[]];

export const VISUAL_INSTRUCTIONS = `The appling server can show the model in a floating window next to the terminal. Use visualize only when the person asks to see, show, draw or visualize part of the model, and pick the view that fits: entities (entities or modules and their associations), machine (one card per state with the actions possible there and where they lead), action (between which states it moves, who may run it, what it requires and changes), usecase (the steps), event (who emits and consumes it).

While the window is open, read what the person clicked with visual_selection when they say "this" or "the selected one", and change the model with propose_edits instead of edit so they can review the change in the window.

Questions typed into the window arrive as <channel source="appling" ask_id="..." selected="..." view="...">. Look things up with the model tools, then answer with visual_reply, passing the ask_id; the answer appears in the window, not in the terminal.`;

/** Tools that drive the floating window. Only the MCP server registers them. */
export function visualTools(host: VisualHost): Tools {
    return {
        visualize: define({
            description: 'Show a view of the model in the floating window next to the terminal, opening it when needed. Use it only when the person asks to see or visualize something. view: entities (focus: entities or modules), machine (machines), action (actions), usecase (use cases), event (events). The person can click elements, ask questions from the window and jump to related elements.',
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
