import type { EditOperation } from '@appling/model';
import type { PanelAction, PanelName, PanelState } from '../shared/panels.js';
import type { TextDiffRequest } from '../shared/review.js';
import type { GenerationSelection } from '@appling/codegen';

/**
 * What a host page may offer the IDE client. Appling Desktop exposes it as `window.applingDesktop` in the repo's
 * view; the Code OSS view (issue #8) implements `openTextDiff` by opening its diff editor. The VS Code extension
 * embeds the IDE in an iframe and offers them over `postMessage` (`frame-host.ts`).
 */
export interface DesktopHooks {
    openTextDiff?(request: TextDiffRequest): void;
    /** An element was selected: Desktop opens its source in the code view. */
    selected?(location: { uri: string, start: number, end: number }): void;
    /**
     * Opens a model file's text from `start` to `end` (offsets) in the host's editor, on the user's request. Where a host
     * offers it, the IDE has no source pane of its own.
     */
    openSource?(location: { uri: string, start: number, end: number }): void;
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
    /**
     * The host draws the side panels itself (`shared/panels.ts`): the IDE has no side column, sends what the panels show
     * after every change, does what they ask and asks the host to show one (`showPanel`).
     */
    panels?(state: PanelState): void;
    onPanelAction?(callback: (action: PanelAction) => void): void;
    showPanel?(name: PanelName): void;
    /** Shows an error where the IDE cannot (`alert` is blocked in a webview). */
    showError?(message: string): void;
    /** Without a target: the host asks for a stack, adds its target and then sends the `generate` panel action. */
    chooseStack?(selection: GenerationSelection): void;
    /** Runs an edit operation on the host's own editors (VS Code's documents, unsaved text included) and saves them. */
    edit?(operation: EditOperation): void;
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
