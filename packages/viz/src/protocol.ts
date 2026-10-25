import type { Graph } from '@appling/model';
import type { ViewKind } from './views.js';

/** What the window draws: a view of the focused elements, with Claude's title and note. */
export interface Show {
    view: ViewKind;
    focus: string[];
    title?: string;
    note?: string;
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
    | { type: 'reply', text: string, askId?: string }
    | { type: 'review', id: string, review: Review }
    | { type: 'reviewed', id: string };

export type WindowMessage =
    | { type: 'select', qn?: string, view: Show }
    | { type: 'ask', text: string }
    | { type: 'decide', id: string, decision: Decision };
