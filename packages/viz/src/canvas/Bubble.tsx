import { useEffect, useRef, type CSSProperties } from 'react';
import type { Bubble } from '../protocol.js';

/** Where the shown bubble is among all of a view's bubbles, with the moves to the one before and after it. */
export interface BubbleStep {
    at: number;
    of: number;
    onBack(): void;
    onNext(): void;
}

export interface BubbleProps {
    bubble: Bubble;
    /** The member the bubble is about when it points at the drawn element that holds it, such as `status`. */
    member?: string;
    style?: CSSProperties;
    /** Scrolls the bubble into view when it appears, in a view that scrolls. */
    reveal?: boolean;
    /** The side of the bubble whose pointer leads to its element. */
    tail?: 'up' | 'left';
    step?: BubbleStep;
    onOpenFile?(file: string, line: number): void;
}

/** A note from Claude on an element; with code, an example of how it is implemented and where. */
export function BubbleView({ bubble, member, style, reveal, tail, step, onOpenFile }: BubbleProps) {
    const element = useRef<HTMLElement>(null);
    useEffect(() => { if (reveal) element.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); }, [bubble, reveal]);
    return (
        <aside ref={element} className={['bubble', bubble.code && 'code', tail && `tail-${tail}`].filter(Boolean).join(' ')} style={style}>
            <div className="bubble-body">
                {member && <span className="bubble-member">{member}</span>}
                <p>{bubble.text}</p>
                {bubble.file && <FileLink file={bubble.file} line={bubble.line ?? 1} onOpenFile={onOpenFile} />}
                {bubble.code && <pre>{bubble.code}</pre>}
            </div>
            {step && step.of > 1 && (
                <div className="bubble-steps">
                    <button disabled={step.at === 0} onClick={step.onBack}>‹ Back</button>
                    <span>{step.at + 1} / {step.of}</span>
                    <button disabled={step.at === step.of - 1} onClick={step.onNext}>Next ›</button>
                </div>
            )}
        </aside>
    );
}

/** The bubbles whose element the view does not draw, in a column at the bottom left. */
export function LooseBubbles({ bubbles, step, onOpenFile }: { bubbles: Bubble[], step?: BubbleStep, onOpenFile?(file: string, line: number): void }) {
    if (!bubbles.length) return null;
    return <div className="loose-bubbles">{bubbles.map((bubble, i) => <BubbleView key={i} bubble={bubble} member={bubble.target} step={step} onOpenFile={onOpenFile} />)}</div>;
}

export function FileLink({ file, line, onOpenFile }: { file: string, line: number, onOpenFile?(file: string, line: number): void }) {
    return <button className="file-link" title="Open in the editor" onClick={() => onOpenFile?.(file, line)}>{file}:{line}</button>;
}

/** The member path of a bubble's target below the element it points at. */
export function memberOf(bubble: Bubble, anchor: string): string | undefined {
    return bubble.target === anchor ? undefined : bubble.target.slice(anchor.length + 1);
}
