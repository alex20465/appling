/**
 * Links in a terminal line. URLs come from xterm's web links addon; this finds file paths with an optional line and
 * column (`src/main.ts:12:5`, `./a.txt`, `/etc/hosts`, `src/app.py(12,5)`, `"src/a b.ts", line 3`) for the
 * terminal view's link provider. Runs in the view (no Node APIs); the main process checks that the file exists.
 */

export interface FileLink {
    /** Offsets in the line, end exclusive. */
    start: number;
    end: number;
    /** The path as written. */
    path: string;
    line?: number;
    column?: number;
}

/** A path: absolute, `~/`, `./`, `../`, a Windows drive, or relative with a folder and a file extension. */
const PATH = String.raw`(?:~|\.{1,2})?[\\/][^\s"'\x60()<>\[\]{}:;,|]+|[A-Za-z]:[\\/][^\s"'\x60()<>\[\]{}:;,|]+|[\w.@-]+(?:[\\/][\w.@-]+)*\.[A-Za-z][A-Za-z0-9]{0,11}`;
/** `:12`, `:12:5`, `(12,5)`, `(12)`, `", line 12` (Python), `on line 12`. */
const SUFFIX = String.raw`(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s?(\d+))?\)|",? line (\d+)(?:, column (\d+))?)?`;
const LINK = new RegExp(String.raw`(?<![\w/\\.~-])("?)(${PATH})${SUFFIX}`, 'g');

export function findFileLinks(text: string): FileLink[] {
    const links: FileLink[] = [];
    for (const match of text.matchAll(LINK)) {
        const quote = match[1];
        let path = match[2];
        // a sentence's full stop or a closing bracket is not part of the path
        const trimmed = path.replace(/[.,]+$/, '');
        const truncated = trimmed !== path;
        path = trimmed;
        if (!path || path === '/' || path === '.' || path === '..' || path === '~') continue;
        const line = truncated ? undefined : match[3] ?? match[5] ?? match[7];
        const column = truncated ? undefined : match[4] ?? match[6] ?? match[8];
        const start = match.index + quote.length;
        const end = truncated ? start + path.length : match.index + match[0].length;
        links.push({ start, end, path, ...line ? { line: Number(line) } : {}, ...column ? { column: Number(column) } : {} });
    }
    return links.filter(link => !insideUrl(text, link.start));
}

/** Whether the offset is inside a `scheme://` URL of the line, which the web links addon handles. */
function insideUrl(text: string, offset: number): boolean {
    for (const match of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s]+/gi)) {
        if (offset >= match.index && offset < match.index + match[0].length) return true;
    }
    return false;
}

/** The offset in a text of a line and column (both from 1), for editors that reveal offsets; past the end it is the end. */
export function offsetAt(text: string, line = 1, column = 1): number {
    let offset = 0;
    for (let current = 1; current < line; current++) {
        const next = text.indexOf('\n', offset);
        if (next < 0) return text.length;
        offset = next + 1;
    }
    const end = text.indexOf('\n', offset);
    return Math.min(offset + Math.max(0, column - 1), end < 0 ? text.length : end);
}

/** Only these open in the browser; everything else a program prints stays a plain text. */
export function isWebUrl(url: string): boolean {
    return /^https?:\/\//i.test(url);
}
