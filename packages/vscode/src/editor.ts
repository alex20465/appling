import { basename } from 'node:path';
import { commands, Range, Selection, TextEditorRevealType, Uri, ViewColumn, window, workspace } from 'vscode';

/** Opening files natively in VS Code: for Desktop's bridge and for the IDE tab. */

/** Opens a file and puts the cursor at the offset `start`, showing `start` to `end`. */
export async function revealOffsets(uri: Uri, start: number, end: number, column?: ViewColumn): Promise<void> {
    const document = await workspace.openTextDocument(uri);
    const editor = await window.showTextDocument(document, { preview: true, viewColumn: column });
    const from = document.positionAt(start);
    editor.selection = new Selection(from, from);
    editor.revealRange(new Range(from, document.positionAt(end)), TextEditorRevealType.InCenterIfOutsideViewport);
}

/** Opens a file at a line range (lines from 1). */
export async function openLines(path: string, start: number, end: number, column?: ViewColumn): Promise<void> {
    const document = await workspace.openTextDocument(Uri.file(path));
    const editor = await window.showTextDocument(document, { preview: true, viewColumn: column });
    const range = new Range(start - 1, 0, Math.max(start, end) - 1, 0);
    editor.selection = new Selection(range.start, range.start);
    editor.revealRange(range, TextEditorRevealType.InCenterIfOutsideViewport);
}

/** Opens the diff editor of a file between a git revision (`before`, its absolute path then) and now (`path`). */
export async function openDiff(path: string, before: string, rev: string, line?: number, column?: ViewColumn): Promise<void> {
    // the built in git extension serves `git:` URIs: the file's text at a revision
    const old = Uri.file(before).with({ scheme: 'git', query: JSON.stringify({ path: before, ref: rev }) });
    const now = Uri.file(path);
    const exists = await workspace.fs.stat(now).then(() => true, () => false);
    const at = line ? new Range(line - 1, 0, line - 1, 0) : undefined;
    if (!exists) {
        await window.showTextDocument(old, { preview: true, selection: at, viewColumn: column });
        return;
    }
    await commands.executeCommand('vscode.diff', old, now, `${basename(path)} (${rev.slice(0, 12)} ↔ Working Tree)`, { preview: true, selection: at, viewColumn: column });
}
