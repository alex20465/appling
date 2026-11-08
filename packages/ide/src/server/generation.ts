import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { GenerationEvent, GenerationSelection } from '@appling/codegen';
import type { GenerationRun } from '../shared/snapshot.js';
import { NO_PLAYBOOK, runTitle, type PlaybookHook } from './generation-chapter.js';

/** Runs one generation and calls back with its events; resolves when it ended. */
export type GenerationSpawner = (root: string, selection: GenerationSelection, onEvent: (event: GenerationEvent) => void) => Promise<void>;

/** The worker thread of `generation-worker.ts`, next to this file (`.ts` under the tests, `.js` when built). */
export const workerSpawner: GenerationSpawner = (root, selection, onEvent) => new Promise(done => {
    const file = new URL(`./generation-worker${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url);
    const worker = new Worker(file, { workerData: { root, selection } });
    let ended = false;
    worker.on('message', (event: GenerationEvent) => {
        if (event.type === 'done') ended = true;
        onEvent(event);
    });
    worker.on('error', error => onEvent({ type: 'failed', message: error.message }));
    worker.on('exit', code => {
        if (!ended) onEvent({ type: 'done', generated: 0, tasks: 0, failed: true });
        if (code && !ended) console.error(`The generation worker ended with code ${code}.`);
        done();
    });
});

/** Parses the selection of a generate request; undefined when it is not one. */
export function parseSelection(input: unknown): GenerationSelection | undefined {
    const value = input as { mode?: unknown, elements?: unknown } | undefined;
    if (value?.mode === 'all' || value?.mode === 'outstanding') return { mode: value.mode };
    if (value?.mode === 'elements' && Array.isArray(value.elements) && value.elements.length && value.elements.every(e => typeof e === 'string' && e)) {
        return { mode: 'elements', elements: value.elements as string[] };
    }
    return undefined;
}

/**
 * One generation run at a time for the IDE's workspace: pushes `{ type: 'generation', run }` when a run starts and
 * ends and `{ type: 'generation-event', id, event }` for each event, and writes the run into a playbook chapter.
 */
export class GenerationRunner {
    private run?: GenerationRun;

    constructor(
        private readonly root: string,
        private readonly broadcast: (message: unknown) => void,
        private readonly playbook: PlaybookHook = NO_PLAYBOOK,
        private readonly spawn: GenerationSpawner = workerSpawner
    ) { }

    /** The running run, else the last one. */
    current(): GenerationRun | undefined {
        return this.run;
    }

    /** Starts a run; undefined while another one runs. */
    start(selection: GenerationSelection, outstanding?: number): GenerationRun | undefined {
        if (this.run && !this.run.ended) return undefined;
        const run: GenerationRun = { id: randomUUID(), title: runTitle(selection, outstanding), selection, started: new Date().toISOString(), events: [] };
        this.run = run;
        let chapter: ReturnType<PlaybookHook['onGenerationRun']> = NO_PLAYBOOK.onGenerationRun(run);
        try {
            chapter = this.playbook.onGenerationRun({ id: run.id, title: run.title, selection, started: run.started });
        } catch (error) {
            console.error(error);
        }
        const safely = (call: () => void) => {
            try {
                call();
            } catch (error) {
                console.error(error);
            }
        };
        this.broadcast({ type: 'generation', run });
        this.spawn(this.root, selection, event => {
            run.events.push(event);
            this.broadcast({ type: 'generation-event', id: run.id, event });
            if (event.type === 'done') safely(() => chapter.close({ failed: event.failed, generated: event.generated, tasks: event.tasks }));
            else if (event.type !== 'start') safely(() => chapter.add(event));
        }).finally(() => {
            run.ended = new Date().toISOString();
            this.broadcast({ type: 'generation', run });
        });
        return run;
    }
}
