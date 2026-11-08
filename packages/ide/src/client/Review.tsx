import { useState } from 'react';
import type { ElementChange } from '@appling/model/diff';
import { kindLabel } from '@appling/viz/views';
import { lineDiff, type ChangedFile, type Review as ReviewData, type Revision, type TextDiffRequest } from '../shared/review.js';
import type { Snapshot } from '../shared/snapshot.js';
import { loadFileDiff } from './api.js';
import { openTextDiff } from './hooks.js';

interface ReviewProps {
    snapshot: Snapshot;
    review?: ReviewData;
    rev: string;
    revisions: Revision[];
    marked: boolean;
    onRev(rev: string): void;
    onMarked(marked: boolean): void;
    onSelect(qn: string): void;
}

const LIMIT = 300;
const STATUS: Record<ChangedFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', untracked: 'U' };

/** The changes since a revision, uncommitted ones by default: the model diff, the changed files and their text diffs. */
export function Review({ snapshot, review, rev, revisions, marked, onRev, onMarked, onSelect }: ReviewProps) {
    const [open, setOpen] = useState<{ key: string, before: string, after: string }>();

    const picker = (
        <label className="review-rev">
            <span>Compare the working tree with</span>
            <select value={rev} onChange={e => { setOpen(undefined); onRev(e.target.value); }}>
                <option value="HEAD">HEAD (uncommitted changes)</option>
                {revisions.map(r => <option key={r.hash} value={r.hash}>{r.short} {r.subject} · {r.date}</option>)}
            </select>
        </label>
    );
    if (!review) return <div className="review">{picker}<p className="muted">Reading git…</p></div>;
    if (!review.ok) return <div className="review"><p className="muted">{review.error}</p></div>;

    const { diff, files, before } = review;
    const fileText = (files: { uri: string, text: string }[], uri: string) => files.find(f => f.uri === uri)?.text ?? '';
    const pathOf = (uri: string) => snapshot.files.find(f => f.uri === uri)?.path ?? before.files.find(f => f.uri === uri)?.path;
    const slice = (text: string, location?: { start: number, end: number }) => location ? text.slice(location.start, location.end) : '';

    /** The element's text before and now, and where its diff opens. */
    const texts = (change: ElementChange) => {
        const [old, now] = [before.locations[change.was ?? change.qn], change.status === 'removed' ? undefined : snapshot.locations[change.qn]];
        const location = now ?? old!;
        const text = fileText(now ? snapshot.files : before.files, location.uri);
        const request: TextDiffRequest = {
            path: pathOf(location.uri)!, rev: review.commit, qn: change.qn,
            line: text.slice(0, location.start).split('\n').length,
            ...(old && pathOf(old.uri) !== pathOf(location.uri) && { before: pathOf(old.uri) })
        };
        return { before: old ? slice(fileText(before.files, old.uri), old) : '', after: now ? slice(fileText(snapshot.files, now.uri), now) : '', request };
    };

    const toggle = (key: string, request: TextDiffRequest, load: () => Promise<{ before: string, after: string } | undefined>) => {
        if (open?.key === key) return setOpen(undefined);
        if (openTextDiff(request)) return;
        load().then(texts => texts && setOpen({ key, ...texts }));
    };

    const shown = diff.changes.slice(0, LIMIT);
    return (
        <div className="review">
            {picker}
            <p className="review-summary">
                <span className="added">{diff.added.length} added</span> · <span className="changed">{diff.changed.length} changed</span> · <span className="removed">{diff.removed.length} removed</span>
                <span className="muted"> since {review.commit.slice(0, 7)}</span>
            </p>
            <label className="tree-option"><input type="checkbox" checked={marked} onChange={e => onMarked(e.target.checked)} /> mark on the canvas</label>

            <h3>Model</h3>
            {!diff.changes.length && <p className="muted">The model has not changed.</p>}
            <ul className="review-list">
                {shown.map(change => {
                    const key = `element ${change.status} ${change.qn}`;
                    return (
                        <li key={key}>
                            <div className={`review-item ${change.status}`}>
                                <button className="result" onClick={() => onSelect(change.qn)} title={change.qn}>
                                    <span>{change.qn}</span>
                                    <span className="muted">{kindLabel(change.kind)}</span>
                                </button>
                                <button className="link" onClick={() => { const t = texts(change); toggle(key, t.request, async () => t); }}>{open?.key === key ? 'close' : 'text diff'}</button>
                            </div>
                            <p className="review-detail muted">
                                {change.status}{change.was && ` from ${change.was}`}
                                {change.status === 'changed' && change.props.length > 0 && ` · ${change.props.join(', ')}`}
                                {change.status === 'changed' && change.edges.added.length + change.edges.removed.length > 0 && ` · ${change.edges.added.length + change.edges.removed.length} reference(s)`}
                            </p>
                            {open?.key === key && <TextDiff before={open.before} after={open.after} />}
                        </li>
                    );
                })}
            </ul>
            {diff.changes.length > LIMIT && <p className="muted">{diff.changes.length - LIMIT} more changes</p>}

            <h3>Files</h3>
            {!files.length && <p className="muted">No file has changed.</p>}
            <ul className="review-list">
                {files.map(file => {
                    const key = `file ${file.path}`;
                    const request: TextDiffRequest = { path: file.path, rev: review.commit, ...(file.from && { before: file.from }) };
                    const load = async () => {
                        const diff = await loadFileDiff(review.commit, file.path, file.from);
                        return 'error' in diff ? undefined : { before: diff.before ?? '', after: diff.after ?? '' };
                    };
                    return (
                        <li key={key}>
                            <button className={`result review-file ${file.status}`} onClick={() => toggle(key, request, load)} title={file.from ? `${file.from} → ${file.path}` : file.path}>
                                <span>{file.path}</span>
                                <span className="muted">{STATUS[file.status]}</span>
                            </button>
                            {open?.key === key && <TextDiff before={open.before} after={open.after} />}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

function TextDiff({ before, after }: { before: string, after: string }) {
    const lines = lineDiff(before, after);
    if (lines.length > 2000) return <p className="muted">The diff is too long to show here.</p>;
    return (
        <pre className="hunk">
            {lines.map((line, i) => <div key={i} className={line.op === '+' ? 'added' : line.op === '-' ? 'removed' : 'muted'}>{line.op} {line.text}</div>)}
        </pre>
    );
}
