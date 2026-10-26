import type { Graph } from '@appling/model';
import type { ViewKind } from './views.js';

/** What the window draws: a view of the focused elements, with Claude's title and note. */
export interface Show {
    view: ViewKind;
    focus: string[];
    title?: string;
    note?: string;
}

/** A note Claude places on an element or one of its members; with `code`, an example of how it is implemented. */
export interface Bubble {
    target: string;
    text: string;
    code?: string;
    /** Relative to the model folder. */
    file?: string;
    line?: number;
}

/** A proposed model change, as `@appling/ai` builds it, with the summary of what and why. */
export interface Review {
    summary: string;
    hunks: { file: string, line: number, removed: string[], added: string[] }[];
    graph: { added: string[], removed: string[], changed: string[] };
}

export type Decision = { accepted: true } | { accepted: false, comment?: string };

export interface Ask {
    id: string;
    text: string;
    selected?: string;
    view?: Show;
}

export type HostMessage =
    | { type: 'graph', graph: Graph }
    | { type: 'show', show: Show }
    | { type: 'bubble', bubble: Bubble }
    | { type: 'reply', text: string, askId?: string }
    | { type: 'review', id: string, review: Review }
    | { type: 'reviewed', id: string };

export type WindowMessage =
    | { type: 'select', qn?: string, view: Show }
    | { type: 'ask', text: string }
    | { type: 'open', file: string, line: number }
    | { type: 'decide', id: string, decision: Decision };

/**
 * The view on screen after `next`: a node view on a node view adds its elements to the ones drawn. The bubbles stay
 * on a node view and on the same view of the same elements.
 */
export function nextShow(current: Show | undefined, next: Show): { show: Show, keep: boolean } {
    if (current?.view !== next.view) return { show: next, keep: false };
    if (next.view === 'node') return { show: { ...next, focus: [...new Set([...current.focus, ...next.focus])] }, keep: true };
    return { show: next, keep: current.focus.join() === next.focus.join() };
}
