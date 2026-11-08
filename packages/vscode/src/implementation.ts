/**
 * The implementation state Appling Desktop sends over the bridge (#20), and what the extension shows of it, without
 * VS Code so it is tested on its own: gutter marks on the model lines, a CodeLens on code that implements an element
 * (back to the element) and one on model lines that have code (to the code). Paths are absolute.
 */

export type MarkState = 'implemented' | 'partial' | 'unimplemented' | 'shifted' | 'broken';

export const MARK_STATES: MarkState[] = ['implemented', 'partial', 'unimplemented', 'shifted', 'broken'];

export interface LineMark {
    /** From 1. */
    line: number;
    qn: string;
    state: MarkState;
    outstanding: boolean;
}

export interface CodeLink {
    qn: string;
    /** Lines from 1, inclusive. */
    start: number;
    end: number;
}

export interface ImplementationState {
    marks: Record<string, LineMark[]>;
    links: Record<string, CodeLink[]>;
}

export const MARK_LABELS: Record<MarkState, string> = {
    implemented: 'implemented', partial: 'partly implemented: open registry tasks', unimplemented: 'not implemented',
    shifted: 'code reference shifted', broken: 'code reference broken'
};

/** The colour of each state's gutter mark, as in the IDE. */
export const MARK_COLORS: Record<MarkState, string> = {
    implemented: '#5cbf63', partial: '#d98a1c', unimplemented: '#aaa092', shifted: '#4c9fe0', broken: '#e5534b'
};

/** The gutter icon of a state, as an SVG data URI: a filled dot, a dashed ring for unimplemented. */
export function markIcon(state: MarkState): string {
    const color = MARK_COLORS[state];
    const dot = state === 'unimplemented'
        ? `<circle cx="8" cy="8" r="3.5" fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="2 1.5"/>`
        : `<circle cx="8" cy="8" r="4" fill="${color}"/>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">${dot}</svg>`)}`;
}

/** The marks of one model file, grouped by state. */
export function marksByState(state: ImplementationState | undefined, path: string): Record<MarkState, LineMark[]> {
    const result = Object.fromEntries(MARK_STATES.map(s => [s, [] as LineMark[]])) as Record<MarkState, LineMark[]>;
    for (const mark of state?.marks[path] ?? []) if (result[mark.state]) result[mark.state].push(mark);
    return result;
}

export function hoverText(mark: LineMark): string {
    return `**${mark.qn}**: ${MARK_LABELS[mark.state]}${mark.outstanding ? ', changed since the last generation' : ''}`;
}

/** One CodeLens on code that implements elements: each element its code range starts with, back to the element. */
export function codeLenses(state: ImplementationState | undefined, path: string): { line: number, qn: string, title: string }[] {
    return (state?.links[path] ?? []).map(link => ({ line: link.start, qn: link.qn, title: `Appling: ${link.qn}` }));
}

/** The code of an element: every link to it, over all files. */
export function codeOf(state: ImplementationState | undefined, qn: string): { path: string, start: number, end: number }[] {
    return Object.entries(state?.links ?? {}).flatMap(([path, links]) => links.filter(l => l.qn === qn).map(l => ({ path, start: l.start, end: l.end })));
}

/** One CodeLens on each model line whose element has code, to open it. */
export function modelLenses(state: ImplementationState | undefined, path: string): { line: number, qn: string, title: string }[] {
    return (state?.marks[path] ?? []).flatMap(mark => {
        const code = codeOf(state, mark.qn);
        return code.length ? [{ line: mark.line, qn: mark.qn, title: code.length === 1 ? 'Open code' : `Open code (${code.length})` }] : [];
    });
}
