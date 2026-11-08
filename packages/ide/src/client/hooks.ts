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
    /** Shows an agent session's tab, such as from its playbook chapter; the session tabs come with #10. */
    focusSession?(session: string): void;
    /**
     * Shows the Changes tab of another repo of the workspace, filtered to a session: a playbook chapter's diff when the
     * chapter came from that repo (#19). `repo` is the chapter's repo folder.
     */
    showChanges?(repo: string, session?: string): void;
    /** Another repo's chapter asked this view to show its Changes tab, filtered to the session. */
    onShowChanges?(callback: (session?: string) => void): void;
    /** Opens a code file in the code view at a line range (paths relative to the repo); absent where there is no code view. */
    openCode?(request: { path: string, start: number, end: number }): void;
    /** The code view asked to show an element, from its code (the Appling extension's CodeLens). */
    onCodeElement?(callback: (qn: string) => void): void;
    /**
     * The workspace this view belongs to now: the one of the window it is in, as a repo may sit in several workspaces
     * (#14). The view plays that workspace's playbook.
     */
    workspace?(): string | undefined;
    /** The view moved to a window of another workspace. */
    onWorkspace?(callback: (workspace: string | undefined) => void): void;
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
