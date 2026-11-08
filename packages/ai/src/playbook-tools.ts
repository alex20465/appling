import { z } from 'zod';
import { define, type Tools } from './tools.js';
import { CHANGE_KINDS, isUnwatched, playbookKey, type Chapter, type Playbook, type PlaybookStore } from './playbook.js';
import { sessionTitle, type AgentSession, type SessionStore } from './sessions.js';

export const PLAYBOOK_INSTRUCTIONS = `The workspace has one shared playbook: a sequential story, in chapters, of what every agent session plans and does, which the person plays on the canvas step by step. It moves only when the person steps forward, so write for a reader who follows one chapter at a time:

- When you start a piece of work, open a chapter with playbook_open_chapter: a short title, the plan in a sentence or two, and the plan as ordered steps. Each step names the model elements it adds, changes or removes (qualified names; show for elements it only explains) and a short note. The person previews the planned steps before you do them, so open the chapter before you change the model and give them a moment to respond.
- As you finish each step, mark it with playbook_step_done; add steps you did not plan with playbook_add_steps. Close the chapter with playbook_close_chapter and the result once the work is done; one chapter per piece of work, no separate report.
- Read the playbook first with playbook_read: it tells which chapter and step the person watches now and what is already in the playbook. Never interrupt: a chapter you open queues after the chapter being watched and never moves the canvas. When your work connects to an earlier chapter, of any session, name it in refs and build on the elements it showed instead of repeating them; write so the chapters read as one coherent flow, not as separate reports.
- The person approves, rejects or comments on steps. Their responses reach your inbox as messages from "User" (read them with session_inbox) and show in playbook_read; act on a rejection or a comment before you mark that step done.`;

const stepInput = z.object({
    elements: z.array(z.string()).describe('Qualified names of the model elements, such as ["sales.Order.discount"]'),
    change: z.enum(CHANGE_KINDS).describe('add, change or remove the elements, or show them to explain'),
    note: z.string().min(1).describe('What the step does and why, in a sentence')
});

/** A chapter for agents: everything but the bookkeeping of the user's watching. */
function brief(chapter: Chapter) {
    return {
        id: chapter.id, title: chapter.title, by: chapter.label, session: chapter.session, repo: chapter.repo, status: chapter.status,
        plan: chapter.plan, result: chapter.result, refs: chapter.refs,
        steps: chapter.steps.map(s => ({ n: s.n, change: s.change, elements: s.elements, note: s.note, state: s.state, ...(s.responses.length ? { responses: s.responses } : {}) }))
    };
}

/** What a session needs to know about where the person is: the watched chapter and step, and what queues after it. */
export function playbookPosition(playbook: Playbook) {
    const at = playbook.chapters.findIndex(c => c.id === playbook.position.chapter);
    const chapter = at >= 0 ? playbook.chapters[at] : undefined;
    return {
        watching: chapter ? { chapter: chapter.id, title: chapter.title, by: chapter.label, step: playbook.position.step, of: chapter.steps.length } : null,
        queued: playbook.chapters.slice(at + 1).filter(isUnwatched).map(c => ({ chapter: c.id, title: c.title, by: c.label })),
        unwatched: playbook.chapters.filter(isUnwatched).length
    };
}

async function attempt(run: () => Promise<unknown>): Promise<unknown> {
    try {
        return await run();
    } catch (error) {
        return { error: (error as Error).message };
    }
}

/** The playbook tools of one session's MCP connection. */
export function playbookTools(id: string, sessions: SessionStore, playbooks: PlaybookStore): Tools {
    const self = async (): Promise<AgentSession> => {
        const session = await sessions.get(id);
        if (!session) throw new Error(`The session ${id} has ended.`);
        return session;
    };
    /** The session's chapter: the one named, else its last open one. */
    const own = async (chapter?: string): Promise<Chapter> => {
        const session = await self();
        const book = await playbooks.read(playbookKey(session));
        const found = chapter ? book.chapters.find(c => c.id === chapter) : book.chapters.findLast(c => c.session === id && c.status === 'open');
        if (!found) throw new Error(chapter ? `No chapter ${chapter} in this workspace's playbook.` : 'You have no open chapter; open one with playbook_open_chapter.');
        if (found.session !== id) throw new Error(`The chapter "${found.title}" belongs to ${found.label}; only its session writes it.`);
        return found;
    };
    const withPosition = async (chapter: Chapter) => ({ chapter: brief(chapter), ...playbookPosition(await playbooks.read(playbookKey(await self()))) });
    return {
        playbook_open_chapter: define({
            description: 'Open a chapter of the workspace\'s playbook for a piece of work you start: a title, the plan, and the plan as ordered steps (elements, change, note) that the person previews and steps through on the canvas. It queues after the chapter the person watches and never moves the canvas. refs names earlier chapters it builds on.',
            input: {
                title: z.string().min(1).max(100),
                plan: z.string().min(1).describe('The plan in a sentence or two'),
                steps: z.array(stepInput).optional(),
                refs: z.array(z.string()).optional().describe('Ids of earlier chapters this one builds on (from playbook_read)')
            },
            run: (_, input) => attempt(async () => {
                const session = await self();
                const chapter = await playbooks.open({
                    workspace: playbookKey(session), session: id, label: sessionTitle(session), color: session.color, repo: session.repo,
                    title: input.title, plan: input.plan, steps: input.steps, refs: input.refs
                });
                return withPosition(chapter);
            })
        }),
        playbook_add_steps: define({
            description: 'Append steps to your open chapter, such as work you did not plan. Without chapter: your last open chapter.',
            input: { chapter: z.string().optional(), steps: z.array(stepInput).min(1) },
            run: (_, input) => attempt(async () => withPosition(await playbooks.add((await own(input.chapter)).id, input.steps)))
        }),
        playbook_step_done: define({
            description: 'Mark steps of your chapter done, by number, with an optional note on how. Without chapter: your last open chapter.',
            input: { chapter: z.string().optional(), steps: z.array(z.number().int().min(1)).min(1), note: z.string().optional() },
            run: (_, input) => attempt(async () => withPosition(await playbooks.done((await own(input.chapter)).id, input.steps, input.note)))
        }),
        playbook_close_chapter: define({
            description: 'Close your chapter with the result of the work, once it is done. Without chapter: your last open chapter.',
            input: { chapter: z.string().optional(), result: z.string().min(1) },
            run: (_, input) => attempt(async () => withPosition(await playbooks.close((await own(input.chapter)).id, input.result)))
        }),
        playbook_read: define({
            description: 'Read the workspace\'s playbook: every chapter with its steps, states and the person\'s responses, which chapter and step the person watches now, and what queues after it. Read it before you open a chapter.',
            input: {},
            run: () => attempt(async () => {
                const book = await playbooks.read(playbookKey(await self()));
                return { ...playbookPosition(book), chapters: book.chapters.map(brief) };
            })
        })
    };
}

/** The message a session gets in its inbox for a response of the user to a step of its chapter. */
export function responseMessage(chapter: Chapter, step: number, kind: string, text?: string): string {
    const verb = kind === 'approve' ? 'approved' : kind === 'reject' ? 'rejected' : 'commented on';
    const found = chapter.steps.find(s => s.n === step);
    return `The person ${verb} step ${step}${found ? ` ("${found.note}")` : ''} of your playbook chapter "${chapter.title}" (${chapter.id})${text ? `: ${text}` : '.'}`;
}

/**
 * Records the user's response to a step and delivers it to the inbox of the session that wrote the chapter, while
 * that session runs. Returns the chapter and whether the session got the message.
 */
export async function respondToStep(playbooks: PlaybookStore, sessions: SessionStore, chapter: string, step: number, response: { kind: 'approve' | 'reject' | 'comment', text?: string }): Promise<{ chapter: Chapter, delivered: boolean }> {
    const updated = await playbooks.respond(chapter, step, response);
    let delivered = false;
    if (updated.session && await sessions.get(updated.session)) {
        await sessions.post(updated.session, { fromLabel: 'User', text: responseMessage(updated, step, response.kind, response.text?.trim()) });
        delivered = true;
    }
    return { chapter: updated, delivered };
}
