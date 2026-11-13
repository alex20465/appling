import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Bubble, Selection, Show, Status } from '@appling/viz/protocol';
import { VIEW_KINDS, type ViewKind } from '@appling/viz/views';
import { define, type Tools } from './tools.js';

/**
 * Where the visual tools draw: the project's canvas in Appling Inspect, for an agent session of the inspect
 * server's `/mcp`. Tests stand in for it.
 */
export interface VisualHost {
    show(show: Show): Promise<void>;
    /** False when nothing can show it. */
    bubble(bubble: Bubble): boolean | Promise<boolean>;
    selection(): Selection | Promise<Selection>;
    reply(text: string): boolean | Promise<boolean>;
    status(status: Status): Promise<void>;
}

const VIEWS = Object.keys(VIEW_KINDS) as [ViewKind, ...ViewKind[]];

export const VISUAL_INSTRUCTIONS = `The appling server shows the model on the project's canvas in Appling, where the person works. Use it when the person asks to see, show, draw or visualize part of the model, and when they ask how a part of the application works: find the elements involved with the model tools, show them with visualize and explain them with visual_bubble, besides a short answer here. Pick the view that fits: node (one declaration or module in the model tree with what uses it), machine (a flowchart of the states and transitions), action (between which states it moves, who may run it, what it requires and changes), usecase (a flowchart of the steps), event (who emits and consumes it).

The canvas never moves on its own: your view and its bubbles wait beside the canvas under your session's name until the person opens them, and then they follow each new view and bubble. Show one node at a time to walk through the model, and place one bubble per step in the order of the explanation; the person steps through them. Pass code, file and line to hint how an element is implemented, such as from code_references. Read what the person selected with visual_selection when they say "this" or "the selected one". The person can type a question to your session in your view; it reaches your inbox as a message from User: answer it with visual_reply.

Every model change, yours and any other, is marked live on the canvas against the last commit, so change the model with edit and write_model_file as usual. During longer work call visual_status at the start of each step with what you do and, when you know it, done and total.`;

/** Tools that drive the project's canvas. Only the MCP server registers them. */
export function visualTools(host: VisualHost): Tools {
    const where = "on the project's canvas in Appling";
    const closed = 'Nothing shows the canvas.';
    return {
        visualize: define({
            description: `Show a view of the model on the project's canvas in Appling, beside the person's own tree until they open it. Use it when the person asks to see or visualize something or asks how a part of the application works. view: node (any declaration or module; adds it to the tree on screen and unfolds what uses it, so you can guide one node at a time), machine (machines, as a flowchart), action (actions), usecase (use cases, as a flowchart), event (events). The person can click elements and jump to related elements.`,
            input: {
                view: z.enum(VIEWS),
                focus: z.array(z.string()).min(1).describe('Qualified names of the elements to draw, such as ["sales.OrderFlow"]'),
                title: z.string().optional().describe('A short title for the view'),
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
            description: `Place a bubble on an element of the view ${where}, or on one of its members such as a field, to say what happens there. With code: a short example that hints how the element is implemented, with the file (relative to the model folder) and line it comes from. The bubbles stay until a different view is shown.`,
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
                return await host.bubble(input) ? { placed: true } : { placed: false, reason: closed };
            }
        }),
        visual_selection: define({
            description: `What the person selected ${where}: the qualified name of the clicked element and the view on screen. open is false when no repo view is open.`,
            input: {},
            run: async () => host.selection()
        }),
        visual_reply: define({
            description: `Answer a question the person typed to your session ${where}; the text appears in your view there. The questions reach your inbox (session_inbox) as messages from User.`,
            input: { text: z.string() },
            run: async (_, input) => (await host.reply(input.text) ? { sent: true } : { sent: false, reason: closed })
        }),
        visual_status: define({
            description: `Show ${where} what you work on now, such as "Modeling the tasks module" or "Implementing registry task 3 of 12"; done and total draw the progress. Call it at the start of each step of a longer task; the earlier steps are kept. Model changes appear there by themselves.`,
            input: {
                text: z.string().describe('The step, in a few words'),
                done: z.number().int().min(0).optional().describe('Steps finished so far'),
                total: z.number().int().min(1).optional().describe('All steps of the task')
            },
            run: async (_, input) => {
                await host.status(input);
                return { shown: true };
            }
        })
    };
}
