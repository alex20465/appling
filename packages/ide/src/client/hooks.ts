import type { TextDiffRequest } from '../shared/review.js';

/**
 * What a host page may offer the IDE client. Appling Desktop exposes it as `window.applingDesktop` in the repo's
 * view; the Code OSS view (issue #8) implements `openTextDiff` by opening its diff editor.
 */
export interface DesktopHooks {
    openTextDiff?(request: TextDiffRequest): void;
    /** An element was selected: Desktop opens its source in the code view. */
    selected?(location: { uri: string, start: number, end: number }): void;
    /** The cursor moved in a `.appling` file of the code view. */
    onCodeCursor?(callback: (uri: string, offset: number) => void): void;
}

declare global {
    interface Window {
        applingDesktop?: DesktopHooks;
    }
}

/** Opens a text diff in the host's code view; false when there is none, and the IDE shows the diff itself. */
export function openTextDiff(request: TextDiffRequest): boolean {
    const hook = window.applingDesktop?.openTextDiff;
    if (!hook) return false;
    hook(request);
    return true;
}
