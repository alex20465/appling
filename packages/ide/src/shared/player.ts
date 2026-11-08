import type { Chapter, Playbook, PlaybookPosition, PlaybookStep } from '@appling/ai';

/**
 * The playbook player's pure logic (#19): where stepping forward and back leads, what the canvas draws for a position
 * and what is queued. The canvas moves only through these, on the user's steps or while the user plays a chapter
 * (`stepDuration` per step); chapters that arrive meanwhile queue.
 */

/** What the canvas draws at a position: the trail of elements so far and the marks of the current step. */
export interface StepView {
    chapter: Chapter;
    /** 0 the chapter's plan, else the step's number. */
    at: number;
    step?: PlaybookStep;
    /** The elements to draw one after another: those of the chapters it builds on, then of its steps up to this one. */
    focus: string[];
    /** The current step's elements as marks; `planned` while the step only previews its change. */
    changes: { added: string[], changed: string[], removed: string[], planned: boolean };
}

export function isUnwatched(chapter: Chapter): boolean {
    return chapter.seen === undefined || chapter.seen < chapter.steps.length;
}

/** Unwatched chapters in total and per session, for the tab count and the session board. */
export function unwatchedCounts(playbook: Playbook | undefined): { total: number, sessions: Record<string, number> } {
    const counts = { total: 0, sessions: {} as Record<string, number> };
    for (const chapter of playbook?.chapters.filter(isUnwatched) ?? []) {
        counts.total++;
        if (chapter.session) counts.sessions[chapter.session] = (counts.sessions[chapter.session] ?? 0) + 1;
    }
    return counts;
}

function at(playbook: Playbook, position: PlaybookPosition): number {
    return playbook.chapters.findIndex(c => c.id === position.chapter);
}

/**
 * One step forward: the next step of the chapter; after its last step the next chapter's plan; from nowhere the first
 * unwatched chapter (else the first). Stays at the very end.
 */
export function forward(playbook: Playbook, position: PlaybookPosition): PlaybookPosition {
    const index = at(playbook, position);
    if (index < 0) {
        const first = playbook.chapters.find(isUnwatched) ?? playbook.chapters[0];
        return first ? { chapter: first.id, step: 0 } : { step: 0 };
    }
    const chapter = playbook.chapters[index];
    if (position.step < chapter.steps.length) return { chapter: chapter.id, step: position.step + 1 };
    const next = playbook.chapters[index + 1];
    return next ? { chapter: next.id, step: 0 } : position;
}

/** One step back: the previous step; from a plan the last step of the previous chapter. Stays at the very start. */
export function back(playbook: Playbook, position: PlaybookPosition): PlaybookPosition {
    const index = at(playbook, position);
    if (index < 0) return position;
    if (position.step > 0) return { chapter: position.chapter, step: position.step - 1 };
    const previous = playbook.chapters[index - 1];
    return previous ? { chapter: previous.id, step: previous.steps.length } : position;
}

/**
 * How long playing shows a step before the next: a look at the canvas plus reading the step's note (the plan for a
 * chapter's start) at about 240 words a minute, 3 to 20 seconds.
 */
export function stepDuration(view: StepView): number {
    const text = view.step ? [view.step.note, view.step.doneNote].filter(Boolean).join(' ') : view.chapter.plan;
    const words = text.split(/\s+/).filter(Boolean).length;
    return Math.min(20_000, Math.max(3_000, 2_000 + words * 250));
}

/** Whether there is anywhere to step forward to. */
export function canForward(playbook: Playbook, position: PlaybookPosition): boolean {
    const next = forward(playbook, position);
    return next.chapter !== position.chapter || next.step !== position.step;
}

/** The chapters after the watched one that the user has not watched yet: what the next steps forward lead to. */
export function queued(playbook: Playbook, position: PlaybookPosition): Chapter[] {
    return playbook.chapters.slice(at(playbook, position) + 1).filter(isUnwatched);
}

/** What the canvas draws at a position; undefined when the position is in no chapter. */
export function stepView(playbook: Playbook, position: PlaybookPosition): StepView | undefined {
    const chapter = playbook.chapters.find(c => c.id === position.chapter);
    if (!chapter) return undefined;
    const step = position.step > 0 ? chapter.steps[position.step - 1] : undefined;
    const earlier = chapter.refs.flatMap(ref => playbook.chapters.find(c => c.id === ref)?.steps.flatMap(s => s.elements) ?? []);
    const own = chapter.steps.slice(0, position.step).flatMap(s => s.elements);
    // The current step's elements come last, so the trail ends at them.
    const current = step?.elements ?? [];
    const focus = [...new Set([...earlier, ...own].filter(e => !current.includes(e))), ...new Set(current)];
    const changes = { added: [] as string[], changed: [] as string[], removed: [] as string[], planned: step?.state !== 'done' };
    if (step?.change === 'add') changes.added.push(...step.elements);
    if (step?.change === 'change') changes.changed.push(...step.elements);
    if (step?.change === 'remove') changes.removed.push(...step.elements);
    return { chapter, at: step ? position.step : 0, step, focus, changes };
}
