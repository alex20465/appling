import { useEffect, useRef, useState } from 'react';
import { monaco } from './monaco.js';

/** A code file to show, with the lines of the element's code. */
export interface OpenCode {
    path: string;
    text: string;
    start: number;
    end: number;
    /** The element the code implements. */
    qn?: string;
}

/**
 * A code file read only, highlighted by Monaco's tokenizers but without a Monaco model: every model goes to the
 * Appling language server, which must see model files only. The element's lines are marked and scrolled to.
 */
export function CodeView({ code, onClose }: { code: OpenCode, onClose(): void }) {
    const [html, setHtml] = useState<string>();
    const body = useRef<HTMLDivElement>(null);
    useEffect(() => {
        let current = true;
        const extension = code.path.slice(code.path.lastIndexOf('.'));
        const language = monaco.languages.getLanguages().find(l => l.extensions?.includes(extension))?.id ?? 'plaintext';
        monaco.editor.colorize(code.text, language, { tabSize: 4 }).then(result => current && setHtml(result), () => current && setHtml(undefined));
        return () => { current = false; };
    }, [code.path, code.text]);
    useEffect(() => {
        body.current?.querySelector(`[data-line="${code.start}"]`)?.scrollIntoView({ block: 'center' });
    }, [html, code.start]);
    // colorize returns one line per `<br/>`; each is numbered and the element's lines marked
    const lines = (html ?? escape(code.text).replaceAll('\n', '<br/>')).split('<br/>');
    return (
        <div className="code-view">
            <header>
                <span className="muted">{code.qn ? `${code.qn} · ` : ''}</span>{code.path}:{code.start}-{code.end}
                <button className="button" onClick={onClose}>Back to the model</button>
            </header>
            <div className="code-body" ref={body}>
                {lines.map((line, i) => (
                    <div key={i} data-line={i + 1} className={i + 1 >= code.start && i + 1 <= code.end ? 'code-line marked' : 'code-line'}>
                        <span className="code-number">{i + 1}</span>
                        <span className="code-text" dangerouslySetInnerHTML={{ __html: line || ' ' }} />
                    </div>
                ))}
            </div>
        </div>
    );
}

function escape(text: string): string {
    return text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}
