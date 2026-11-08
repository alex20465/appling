import { openChapter, type ChapterWriter, type PlaybookStore, type StepInput } from '@appling/ai';
import type { GenerationEvent, GenerationSelection } from '@appling/codegen';

/**
 * Where a generation run goes in the playbook (#19): every run opens one chapter, adds its events in order and closes
 * it with the result. `playbookChapters` writes them into the workspace playbook; `NO_PLAYBOOK` drops everything.
 */
export interface PlaybookHook {
    onGenerationRun(run: GenerationRunInfo): GenerationChapter;
}

export interface GenerationRunInfo {
    id: string;
    /** Such as "Generate 3 outstanding elements". */
    title: string;
    selection: GenerationSelection;
    started: string;
}

export interface GenerationChapter {
    /** One event of the run, in order: `planned`, `log`, `merged`, `generated`, `tasks`, `skipped`, `failed` (see `@appling/codegen`). */
    add(event: GenerationEvent): void;
    close(result: { failed: boolean, generated: number, tasks: number }): void;
}

export const NO_PLAYBOOK: PlaybookHook = {
    onGenerationRun: () => ({ add: () => undefined, close: () => undefined })
};

/** The author of generation chapters: the app itself, no agent session. */
export const GENERATION_AUTHOR = { label: 'Code generation', color: '#a85f17' };

/** At most this many elements per step; the rest is counted in the note. */
const ELEMENTS = 40;

/**
 * Generation runs as chapters of the workspace playbook: the plan names the selection; each target adds a planned step
 * with the elements it generates, done once they are generated (with the files, references and the merge); the
 * registry tasks it left, a skip or a failure each add a step of their own; the chapter closes with the summary.
 * Writes are queued so they keep the run's order; a failing write is logged and never stops the run.
 */
export function playbookChapters(store: PlaybookStore, workspace: () => Promise<string>, repo: string): PlaybookHook {
    return {
        onGenerationRun(run) {
            let queue: Promise<ChapterWriter | undefined> = workspace()
                .then(key => openChapter(store, { workspace: key, repo, ...GENERATION_AUTHOR }, { title: run.title, plan: planOf(run.selection) }))
                .catch(error => (console.error(error), undefined));
            const write = (step: (chapter: ChapterWriter) => Promise<unknown>) => {
                queue = queue.then(async chapter => {
                    if (chapter) await step(chapter).catch(error => console.error(error));
                    return chapter;
                });
            };
            /** The step number of each target's planned step. */
            const planned = new Map<string, number>();
            const merged = new Map<string, string>();
            const append = (step: StepInput, done = true) => write(async chapter => {
                const next = await chapter.add([step]);
                const n = next.steps.at(-1)!.n;
                if (done) await chapter.done([n]);
                return n;
            });
            return {
                add(event) {
                    if (event.type === 'planned') {
                        write(async chapter => {
                            const next = await chapter.add([{ elements: tops(event.elements), change: event.mode === 'create' ? 'add' : 'change', note: `${event.target}: ${event.mode === 'create' ? 'create the project' : 'merge into the project'}, ${count(event.elements.length, 'element')}, ${count(event.steps.length, 'step')}${more(event.elements)}` }]);
                            planned.set(event.target, next.steps.at(-1)!.n);
                        });
                    } else if (event.type === 'merged') {
                        const r = event.report;
                        merged.set(event.target, [r.updated.length && `${r.updated.length} updated`, r.added.length && `${r.added.length} added`, r.merged.length && `${r.merged.length} merged`, r.conflicts.length && `${r.conflicts.length} with conflicts`, r.removed.length && `${r.removed.length} removed`].filter(Boolean).join(', ') || 'no file changed');
                    } else if (event.type === 'generated') {
                        const files = new Set(event.elements.flatMap(e => e.files));
                        write(async chapter => {
                            const n = planned.get(event.target);
                            const note = `${count(event.elements.length, 'element')} generated, ${count(files.size, 'file')}, ${count(event.references, 'code reference')}${merged.has(event.target) ? `; files: ${merged.get(event.target)}` : ''}`;
                            if (n) await chapter.done([n], note);
                        });
                    } else if (event.type === 'tasks' && event.tasks.length) {
                        append({ elements: tops(event.tasks.map(t => t.qn)), change: 'show', note: `${event.target}: ${count(event.tasks.length, 'element')} with open registry tasks, for agent sessions (registry_next): ${event.tasks.slice(0, 5).map(t => `${t.qn}: ${t.missing[0]}`).join('; ')}${event.tasks.length > 5 ? '; …' : ''}` });
                    } else if (event.type === 'skipped') {
                        append({ elements: [], change: 'show', note: `${event.target}: ${event.reason}` });
                    } else if (event.type === 'failed') {
                        append({ elements: [], change: 'show', note: `${event.target ? `${event.target} failed: ` : 'Failed: '}${event.message.slice(0, 500)}` });
                    }
                },
                close(result) {
                    write(chapter => chapter.close(result.failed ? `Failed; ${count(result.generated, 'element')} generated` : `${count(result.generated, 'element')} generated, ${count(result.tasks, 'element')} with open registry tasks`));
                }
            };
        }
    };
}

export function runTitle(selection: GenerationSelection, outstanding?: number): string {
    if (selection.mode === 'all') return 'Generate everything';
    if (selection.mode === 'outstanding') return outstanding === undefined ? 'Generate the outstanding elements' : `Generate ${count(outstanding, 'outstanding element')}`;
    return selection.elements.length === 1 ? `Generate ${selection.elements[0]}` : `Generate ${selection.elements.length} elements`;
}

function planOf(selection: GenerationSelection): string {
    if (selection.mode === 'all') return 'Generate the whole model through the targets of appling.config.json.';
    if (selection.mode === 'outstanding') return 'Generate what is new or changed in the model since the last generation, through the targets of appling.config.json.';
    return `Generate ${selection.elements.join(', ')} with their members, through the targets of appling.config.json.`;
}

/** The declarations of the list, without modules and without members of others in the list, at most `ELEMENTS`. */
function tops(elements: string[]): string[] {
    const set = new Set(elements);
    return elements.filter(qn => {
        const parts = qn.split('.');
        if (parts.length === 1) return false;
        for (let i = 2; i < parts.length; i++) if (set.has(parts.slice(0, i).join('.'))) return false;
        return true;
    }).slice(0, ELEMENTS);
}

function more(elements: string[]): string {
    const shown = tops(elements).length;
    return shown < elements.length ? ` (the step shows ${shown})` : '';
}

function count(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}
