import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoFolder, type Channel } from './sessions.js';

/**
 * The playbook of a workspace: one sequential story, in chapters, of what the agent sessions of all its repos plan and
 * do, played on the canvas step by step only when the user steps forward. A session opens a chapter with its plan as
 * ordered steps (each with the elements it adds, changes or removes and a note), marks the steps done as it works and
 * closes the chapter with the result. Chapters added while the user watches another one queue after it.
 *
 * Like the session store, the playbooks live in Appling Desktop's main process (one `MemoryPlaybookStore`, kept on
 * disk in the app's data folder, served to every IDE server child over IPC with `servePlaybookStore` and
 * `RemotePlaybookStore`); a lone IDE server keeps its own.
 */

/** What a step does to its elements: adds, changes or removes them, or only shows them. */
export const CHANGE_KINDS = ['add', 'change', 'remove', 'show'] as const;
export type ChangeKind = typeof CHANGE_KINDS[number];

export const RESPONSE_KINDS = ['approve', 'reject', 'comment'] as const;
export type ResponseKind = typeof RESPONSE_KINDS[number];

export interface StepInput {
    /** Qualified names of the model elements the step adds, changes, removes or shows. */
    elements: string[];
    change: ChangeKind;
    note: string;
}

/** The user's answer to a step; it also reaches the session that wrote the chapter as a message. */
export interface StepResponse {
    kind: ResponseKind;
    text?: string;
    at: string;
}

export interface PlaybookStep extends StepInput {
    /** 1, 2, 3 ... in the chapter's order. */
    n: number;
    /** Planned steps preview their change; done steps happened. */
    state: 'planned' | 'done';
    /** What the session says about the step once done. */
    doneNote?: string;
    doneAt?: string;
    responses: StepResponse[];
}

export interface Chapter {
    id: string;
    /** The agent session that writes the chapter; none for chapters the app writes itself, such as a generation run. */
    session?: string;
    /** The session's label and colour when it wrote the chapter, kept after the session ends. */
    label: string;
    color: string;
    /** The repo whose model the chapter's elements belong to. */
    repo: string;
    title: string;
    plan: string;
    steps: PlaybookStep[];
    status: 'open' | 'closed';
    result?: string;
    /** Ids of earlier chapters this one builds on. */
    refs: string[];
    opened: string;
    closed?: string;
    /** How many of its steps the user has watched; a chapter is unwatched while this is below its step count. */
    seen?: number;
}

/** Where the user is in the playbook: a chapter and a step in it (0 its plan, 1 the first step), or nowhere. */
export interface PlaybookPosition {
    chapter?: string;
    step: number;
}

export interface Playbook {
    /** The workspace id, or the repo folder for sessions without a workspace. */
    workspace: string;
    chapters: Chapter[];
    position: PlaybookPosition;
}

export interface OpenChapter {
    workspace: string;
    session?: string;
    label: string;
    color: string;
    repo: string;
    title: string;
    plan: string;
    steps?: StepInput[];
    refs?: string[];
}

/** Where playbooks live. Every method is async so a store can live in another process. */
export interface PlaybookStore {
    /** Opens a chapter at the end of the workspace's playbook, after the chapter the user watches. */
    open(input: OpenChapter): Promise<Chapter>;
    /** Appends steps to an open chapter. */
    add(chapter: string, steps: StepInput[]): Promise<Chapter>;
    /** Marks steps (by number) done. */
    done(chapter: string, steps: number[], note?: string): Promise<Chapter>;
    close(chapter: string, result: string): Promise<Chapter>;
    /** The chapter with this id, in any workspace. */
    chapter(id: string): Promise<Chapter | undefined>;
    /** The workspace's playbook; an empty one when nothing was written yet. */
    read(workspace: string): Promise<Playbook>;
    /** Moves the user to a chapter and step, which counts as watched up to there. */
    move(workspace: string, position: PlaybookPosition): Promise<Playbook>;
    /** Records the user's response to a step. */
    respond(chapter: string, step: number, response: Omit<StepResponse, 'at'>): Promise<Chapter>;
    /** Calls back with the workspace's playbook after each change of it. */
    onChange(listener: (playbook: Playbook) => void): () => void;
}

/** The playbook key of a session: its workspace, else its repo folder. */
export function playbookKey(session: { workspace?: string, repo: string }): string {
    return session.workspace ?? repoFolder(session.repo);
}

/** Whether the user has not yet watched every step of the chapter. */
export function isUnwatched(chapter: Chapter): boolean {
    return chapter.seen === undefined || chapter.seen < chapter.steps.length;
}

/** The unwatched chapters, in total, per session and per repo, for the rail and the session board. */
export function unwatched(playbook: Playbook): { total: number, sessions: Record<string, number>, repos: Record<string, number> } {
    const counts = { total: 0, sessions: {} as Record<string, number>, repos: {} as Record<string, number> };
    for (const chapter of playbook.chapters.filter(isUnwatched)) {
        counts.total++;
        if (chapter.session) counts.sessions[chapter.session] = (counts.sessions[chapter.session] ?? 0) + 1;
        counts.repos[chapter.repo] = (counts.repos[chapter.repo] ?? 0) + 1;
    }
    return counts;
}

function validSteps(steps: StepInput[]): StepInput[] {
    for (const step of steps) {
        if (!CHANGE_KINDS.includes(step.change)) throw new Error(`Unknown change ${step.change}; one of ${CHANGE_KINDS.join(', ')}.`);
        if (!Array.isArray(step.elements)) throw new Error('A step needs its elements (an empty list for none).');
    }
    return steps;
}

/** Playbooks in memory, for one process; with a folder, each workspace's playbook is also kept there as a JSON file. */
export class MemoryPlaybookStore implements PlaybookStore {

    private readonly books = new Map<string, Playbook>();
    private readonly listeners = new Set<(playbook: Playbook) => void>();

    constructor(private readonly folder?: string) {
        if (!folder || !existsSync(folder)) return;
        for (const file of readdirSync(folder).filter(f => f.endsWith('.json'))) {
            try {
                const book = JSON.parse(readFileSync(join(folder, file), 'utf8')) as Playbook;
                if (typeof book.workspace === 'string' && Array.isArray(book.chapters)) this.books.set(book.workspace, { ...book, position: book.position ?? { step: 0 } });
            } catch {
                // a broken file is left alone
            }
        }
    }

    async open(input: OpenChapter): Promise<Chapter> {
        const book = this.book(input.workspace);
        const refs = input.refs ?? [];
        for (const ref of refs) if (!book.chapters.some(c => c.id === ref)) throw new Error(`No chapter ${ref} in this playbook to refer to.`);
        const chapter: Chapter = {
            id: randomUUID(), session: input.session, label: input.label, color: input.color, repo: repoFolder(input.repo),
            title: input.title, plan: input.plan, steps: [], status: 'open', refs, opened: new Date().toISOString()
        };
        chapter.steps = validSteps(input.steps ?? []).map((step, i) => this.step(step, i + 1));
        book.chapters.push(chapter);
        this.changed(book);
        return structuredClone(chapter);
    }

    async add(id: string, steps: StepInput[]): Promise<Chapter> {
        const [book, chapter] = this.find(id);
        if (chapter.status === 'closed') throw new Error(`The chapter "${chapter.title}" is closed; open a new one.`);
        chapter.steps.push(...validSteps(steps).map((step, i) => this.step(step, chapter.steps.length + i + 1)));
        this.changed(book);
        return structuredClone(chapter);
    }

    async done(id: string, steps: number[], note?: string): Promise<Chapter> {
        const [book, chapter] = this.find(id);
        for (const n of steps) {
            const step = chapter.steps.find(s => s.n === n);
            if (!step) throw new Error(`The chapter "${chapter.title}" has no step ${n}.`);
            step.state = 'done';
            step.doneAt = new Date().toISOString();
            if (note?.trim()) step.doneNote = note.trim();
        }
        this.changed(book);
        return structuredClone(chapter);
    }

    async close(id: string, result: string): Promise<Chapter> {
        const [book, chapter] = this.find(id);
        chapter.status = 'closed';
        chapter.result = result;
        chapter.closed = new Date().toISOString();
        this.changed(book);
        return structuredClone(chapter);
    }

    async chapter(id: string): Promise<Chapter | undefined> {
        for (const book of this.books.values()) {
            const chapter = book.chapters.find(c => c.id === id);
            if (chapter) return structuredClone(chapter);
        }
        return undefined;
    }

    async read(workspace: string): Promise<Playbook> {
        return structuredClone(this.books.get(workspace) ?? { workspace, chapters: [], position: { step: 0 } });
    }

    /** Every playbook this store holds, such as for the counts of Appling Desktop's rail. */
    all(): Playbook[] {
        return structuredClone([...this.books.values()]);
    }

    async move(workspace: string, position: PlaybookPosition): Promise<Playbook> {
        const book = this.book(workspace);
        const chapter = position.chapter === undefined ? undefined : book.chapters.find(c => c.id === position.chapter);
        if (position.chapter !== undefined && !chapter) throw new Error(`No chapter ${position.chapter} in this playbook.`);
        const step = chapter ? Math.max(0, Math.min(Math.floor(position.step) || 0, chapter.steps.length)) : 0;
        book.position = { chapter: chapter?.id, step };
        if (chapter) chapter.seen = Math.max(chapter.seen ?? 0, step);
        this.changed(book);
        return structuredClone(book);
    }

    async respond(id: string, n: number, response: Omit<StepResponse, 'at'>): Promise<Chapter> {
        const [book, chapter] = this.find(id);
        if (!RESPONSE_KINDS.includes(response.kind)) throw new Error(`Unknown response ${response.kind}; one of ${RESPONSE_KINDS.join(', ')}.`);
        const step = chapter.steps.find(s => s.n === n);
        if (!step) throw new Error(`The chapter "${chapter.title}" has no step ${n}.`);
        step.responses.push({ kind: response.kind, ...(response.text?.trim() ? { text: response.text.trim() } : {}), at: new Date().toISOString() });
        this.changed(book);
        return structuredClone(chapter);
    }

    onChange(listener: (playbook: Playbook) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private step(input: StepInput, n: number): PlaybookStep {
        return { n, elements: [...input.elements], change: input.change, note: input.note, state: 'planned', responses: [] };
    }

    private book(workspace: string): Playbook {
        let book = this.books.get(workspace);
        if (!book) this.books.set(workspace, book = { workspace, chapters: [], position: { step: 0 } });
        return book;
    }

    private find(id: string): [Playbook, Chapter] {
        for (const book of this.books.values()) {
            const chapter = book.chapters.find(c => c.id === id);
            if (chapter) return [book, chapter];
        }
        throw new Error(`No chapter ${id}.`);
    }

    private changed(book: Playbook): void {
        if (this.folder) {
            mkdirSync(this.folder, { recursive: true });
            const file = join(this.folder, `${createHash('sha256').update(book.workspace).digest('hex').slice(0, 20)}.json`);
            writeFileSync(`${file}.tmp`, `${JSON.stringify(book, null, 2)}\n`);
            renameSync(`${file}.tmp`, file);
        }
        if (!this.listeners.size) return;
        const copy = structuredClone(book);
        this.listeners.forEach(listener => listener(copy));
    }
}

/** Who writes a chapter without MCP, such as a code generation run of the app (#20). */
export interface ChapterAuthor {
    workspace: string;
    repo: string;
    label: string;
    color: string;
    /** The agent session the chapter belongs to, if any: responses reach it as messages. */
    session?: string;
}

/** An open chapter, written step by step: `add` steps, mark them `done`, `close` with the result. */
export interface ChapterWriter {
    id: string;
    add(steps: StepInput[]): Promise<Chapter>;
    done(steps: number[], note?: string): Promise<Chapter>;
    close(result: string): Promise<Chapter>;
    /** The chapter now, with the user's responses to its steps. */
    read(): Promise<Chapter | undefined>;
}

/**
 * Opens a playbook chapter without MCP, for the app's own work such as a code generation run, and returns its writer:
 *
 * ```ts
 * const chapter = await openChapter(playbooks, { workspace, repo, label: 'Generate Django', color: '#1971c2' },
 *     { title: 'Generate the Django project', plan: 'One app per module', steps: [{ elements: ['sales.Order'], change: 'show', note: 'models.py' }] });
 * await chapter.done([1]);
 * await chapter.close('Generated 12 files');
 * ```
 */
export async function openChapter(store: PlaybookStore, author: ChapterAuthor, chapter: { title: string, plan: string, steps?: StepInput[], refs?: string[] }): Promise<ChapterWriter> {
    const opened = await store.open({ ...author, ...chapter });
    return {
        id: opened.id,
        add: steps => store.add(opened.id, steps),
        done: (steps, note) => store.done(opened.id, steps, note),
        close: result => store.close(opened.id, result),
        read: () => store.chapter(opened.id)
    };
}

type PlaybookMethod = Exclude<keyof PlaybookStore, 'onChange'>;
const METHODS: PlaybookMethod[] = ['open', 'add', 'done', 'close', 'chapter', 'read', 'move', 'respond'];

interface Call { type: 'playbook:call', call: number, method: PlaybookMethod, args: unknown[] }
interface Result { type: 'playbook:result', call: number, result?: unknown, error?: string }
interface Change { type: 'playbook:change', playbook: Playbook }

/** Serves a playbook store to another process over a channel: its calls and every change. Returns the function that stops. */
export function servePlaybookStore(store: PlaybookStore, channel: Channel): () => void {
    const stopChanges = store.onChange(playbook => channel.send({ type: 'playbook:change', playbook } satisfies Change));
    const stopCalls = channel.onMessage(async message => {
        const call = message as Call;
        if (call?.type !== 'playbook:call' || !METHODS.includes(call.method)) return;
        try {
            const result = await (store[call.method] as (...args: unknown[]) => Promise<unknown>)(...call.args);
            channel.send({ type: 'playbook:result', call: call.call, result } satisfies Result);
        } catch (error) {
            channel.send({ type: 'playbook:result', call: call.call, error: (error as Error).message } satisfies Result);
        }
    });
    return () => {
        stopChanges();
        stopCalls();
    };
}

/** A playbook store that lives in another process, reached over a channel that `servePlaybookStore` serves. */
export class RemotePlaybookStore implements PlaybookStore {

    private calls = new Map<number, { done(value: unknown): void, fail(error: Error): void }>();
    private listeners = new Set<(playbook: Playbook) => void>();
    private next = 0;

    constructor(private readonly channel: Channel, private readonly timeout = 10000) {
        channel.onMessage(message => {
            const reply = message as Result | Change;
            if (reply?.type === 'playbook:change') this.listeners.forEach(listener => listener(reply.playbook));
            if (reply?.type !== 'playbook:result') return;
            const pending = this.calls.get(reply.call);
            this.calls.delete(reply.call);
            if (reply.error !== undefined) pending?.fail(new Error(reply.error));
            else pending?.done(reply.result);
        });
    }

    open(input: OpenChapter) { return this.call<Chapter>('open', input); }
    add(chapter: string, steps: StepInput[]) { return this.call<Chapter>('add', chapter, steps); }
    done(chapter: string, steps: number[], note?: string) { return this.call<Chapter>('done', chapter, steps, note); }
    close(chapter: string, result: string) { return this.call<Chapter>('close', chapter, result); }
    chapter(id: string) { return this.call<Chapter | undefined>('chapter', id); }
    read(workspace: string) { return this.call<Playbook>('read', workspace); }
    move(workspace: string, position: PlaybookPosition) { return this.call<Playbook>('move', workspace, position); }
    respond(chapter: string, step: number, response: Omit<StepResponse, 'at'>) { return this.call<Chapter>('respond', chapter, step, response); }

    onChange(listener: (playbook: Playbook) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private call<T>(method: PlaybookMethod, ...args: unknown[]): Promise<T> {
        const call = this.next++;
        return new Promise<T>((done, fail) => {
            const timer = setTimeout(() => {
                this.calls.delete(call);
                fail(new Error(`The playbook store did not answer ${method} within ${this.timeout}ms.`));
            }, this.timeout);
            this.calls.set(call, {
                done: value => { clearTimeout(timer); done(value as T); },
                fail: error => { clearTimeout(timer); fail(error); }
            });
            this.channel.send({ type: 'playbook:call', call, method, args } satisfies Call);
        });
    }
}
