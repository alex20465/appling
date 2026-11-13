import type { PanelAction, PanelName, PanelState } from '../shared/panels.js';
import type { TextDiffRequest } from '../shared/review.js';

/**
 * What a host page may offer the inspector client as `window.applingHost`: the VS Code extension embeds the inspector
 * in an iframe and offers them over `postMessage` (`frame-host.ts`). In a plain browser there is none.
 */
export interface HostHooks {
    openTextDiff?(request: TextDiffRequest): void;
    /**
     * Opens a model file's text from `start` to `end` (offsets) in the host's editor, on the user's request.
     */
    openSource?(location: { uri: string, start: number, end: number }): void;
    /** The cursor moved in a `.appling` editor of the host. */
    onCodeCursor?(callback: (uri: string, offset: number) => void): void;
    /** Shows an agent session's tab, such as from its claim ring on the canvas. */
    focusSession?(session: string): void;
    /** The host asked to show an element, such as from its code (the Appling extension's CodeLens). */
    onCodeElement?(callback: (qn: string) => void): void;
    /**
     * The host draws the side panels itself (`shared/panels.ts`): the client draws no inspector, sends what the panels
     * show after every change, does what they ask and asks the host to show one (`showPanel`).
     */
    panels?(state: PanelState): void;
    onPanelAction?(callback: (action: PanelAction) => void): void;
    showPanel?(name: PanelName): void;
}

declare global {
    interface Window {
        applingHost?: HostHooks;
    }
}

/** Opens a text diff in the host's editor, where it has one. */
export function openTextDiff(request: TextDiffRequest): void {
    window.applingHost?.openTextDiff?.(request);
}
