import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, type Node, type Tree } from 'web-tree-sitter';

/**
 * Code markers: the code names the element it implements in a doc comment or docstring line of its own,
 * `@appling <qualified name> <fingerprint>`, and the declaration the marker belongs to is its range, found by parsing.
 * Markers move with the code, so line numbers are never stored.
 */
export interface Marker {
    qn: string;
    /** The element's fingerprint when the code was written against it. */
    fingerprint?: string;
    /** The marker's own line, from 1. */
    line: number;
    /** The declaration it marks, from 1. */
    start: number;
    end: number;
}

interface Syntax {
    /** The line comment a marker is written with. */
    comment: string;
    /** The tree-sitter grammar, as a package path. Without one the range follows the indentation. */
    grammar?: string;
    /** Node types that hold statements: a string marker belongs to the declaration around its statement. */
    blocks?: string[];
    /** Statements whose string documents the declaration after them, such as Elixir's `@doc`. */
    documentsNext?: RegExp;
}

const PYTHON: Syntax = { comment: '#', grammar: 'tree-sitter-python/tree-sitter-python.wasm', blocks: ['module', 'block'] };
const ELIXIR: Syntax = { comment: '#', grammar: 'tree-sitter-elixir/tree-sitter-elixir.wasm', blocks: ['source', 'do_block', 'body'], documentsNext: /^@(doc|typedoc)\b/ };
const GO: Syntax = { comment: '//', grammar: 'tree-sitter-go/tree-sitter-go.wasm' };
const RUST: Syntax = { comment: '//', grammar: 'tree-sitter-rust/tree-sitter-rust.wasm' };
const TYPESCRIPT: Syntax = { comment: '//', grammar: 'tree-sitter-typescript/tree-sitter-typescript.wasm' };
const TSX: Syntax = { comment: '//', grammar: 'tree-sitter-typescript/tree-sitter-tsx.wasm' };
const JAVASCRIPT: Syntax = { comment: '//', grammar: 'tree-sitter-javascript/tree-sitter-javascript.wasm' };
const HASH: Syntax = { comment: '#' };
const SLASHES: Syntax = { comment: '//' };
const DASHES: Syntax = { comment: '--' };

/** The code files markers are looked for in, by extension. */
export const MARKER_LANGUAGES: Record<string, Syntax> = {
    '.py': PYTHON, '.ex': ELIXIR, '.exs': ELIXIR, '.go': GO, '.rs': RUST,
    '.ts': TYPESCRIPT, '.mts': TYPESCRIPT, '.cts': TYPESCRIPT, '.tsx': TSX, '.js': JAVASCRIPT, '.mjs': JAVASCRIPT, '.cjs': JAVASCRIPT, '.jsx': JAVASCRIPT,
    '.rb': HASH, '.sh': HASH, '.toml': HASH, '.yaml': HASH, '.yml': HASH,
    '.java': SLASHES, '.kt': SLASHES, '.swift': SLASHES, '.c': SLASHES, '.h': SLASHES, '.cpp': SLASHES, '.cs': SLASHES, '.php': SLASHES, '.dart': SLASHES, '.scala': SLASHES,
    '.sql': DASHES, '.lua': DASHES
};

/** A line that is a marker and nothing else, after a comment prefix or inside a docstring. */
const MARKER = /^\s*(?:#+|\/\/+!?|--|\/?\*+|;+)?\s*@appling\s+(\S+)(?:\s+([0-9a-f]{8}))?\s*(?:\*\/)?\s*$/;
const COMMENT_LINE = /^\s*(?:#|\/\/|--|\/\*|\*)/;
const CLOSING = /^\s*(?:[}\])]|end\b)/;

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/** A wasm file: next to a bundle in `grammars/` (the VS Code extension copies them there), else from its package. */
function wasm(path: string): string {
    const bundled = join(here, 'grammars', basename(path));
    return existsSync(bundled) ? bundled : require.resolve(path);
}

let ready: Promise<Parser> | undefined;
const languages = new Map<string, Promise<Language>>();

async function parse(text: string, grammar: string): Promise<Tree | undefined> {
    ready ??= Parser.init({ locateFile: (name: string) => wasm(`web-tree-sitter/${name}`) }).then(() => new Parser());
    const parser = await ready;
    if (!languages.has(grammar)) languages.set(grammar, Language.load(wasm(grammar)));
    parser.setLanguage(await languages.get(grammar)!);
    return parser.parse(text) ?? undefined;
}

/** The markers of one code file's text, by its extension; none for a file without a marker language. */
export async function findMarkers(text: string, extension: string): Promise<Marker[]> {
    const syntax = MARKER_LANGUAGES[extension];
    if (!syntax || !text.includes('@appling')) return [];
    const lines = text.split('\n');
    const found = lines.flatMap((line, row) => {
        const match = MARKER.exec(line);
        return match ? [{ row, column: line.indexOf('@appling'), qn: match[1], fingerprint: match[2] }] : [];
    });
    if (!found.length) return [];
    const tree = syntax.grammar ? await parse(text, syntax.grammar) : undefined;
    return found.flatMap(({ row, column, qn, fingerprint }) => {
        let range: { start: number, end: number } | undefined;
        if (tree) {
            const carrier = carrierOf(tree.rootNode.descendantForPosition({ row, column }));
            // a marker line in code, not in a comment or a string, is no marker
            if (!carrier) return [];
            const declaration = declarationOf(carrier, syntax);
            // nothing after it to mark, such as at the end of a block: the marker's own line
            range = declaration ? { start: declaration.startPosition.row + 1, end: declaration.endPosition.row + 1 } : { start: row + 1, end: row + 1 };
        }
        range ??= indented(lines, row);
        return [{ qn, ...(fingerprint && { fingerprint }), line: row + 1, ...range }];
    });
}

const isComment = (node: Node) => node.type.includes('comment');
const isString = (node: Node) => /string|heredoc|sigil/.test(node.type);

function carrierOf(node: Node | null): Node | undefined {
    for (let current = node; current; current = current.parent) if (isComment(current) || isString(current)) return current;
    return undefined;
}

/** A comment marks the declaration after it; a string the declaration around its statement (a docstring). */
function declarationOf(carrier: Node, syntax: Syntax): Node | undefined {
    if (isComment(carrier)) return nextDeclaration(carrier, syntax);
    let statement = carrier;
    while (statement.parent && !syntax.blocks?.includes(statement.parent.type)) statement = statement.parent;
    const block = statement.parent;
    if (!block) return undefined;
    if (syntax.documentsNext?.test(statement.text)) return nextDeclaration(statement, syntax);
    return block.parent ?? block;
}

function nextDeclaration(node: Node, syntax: Syntax): Node | undefined {
    let next = node.nextNamedSibling;
    while (next && isComment(next)) next = next.nextNamedSibling;
    // a comment right after a header can sit before the block it opens: the block's first statement is meant
    if (next && syntax.blocks?.includes(next.type)) {
        next = next.firstNamedChild;
        while (next && isComment(next)) next = next.nextNamedSibling;
    }
    return next ?? undefined;
}

/** Without a grammar: the first code line after the marker and every line indented deeper, with a closing line. */
function indented(lines: string[], row: number): { start: number, end: number } {
    let first = row + 1;
    while (first < lines.length && (!lines[first].trim() || COMMENT_LINE.test(lines[first]))) first++;
    if (first >= lines.length) return { start: row + 1, end: row + 1 };
    const indent = (line: string) => line.length - line.trimStart().length;
    const base = indent(lines[first]);
    let last = first;
    for (let i = first + 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        if (indent(lines[i]) > base) last = i;
        else {
            if (indent(lines[i]) === base && CLOSING.test(lines[i])) last = i;
            break;
        }
    }
    return { start: first + 1, end: last + 1 };
}

/**
 * The first line of the largest declaration that lies within some lines of a text (from 1), such as the page function
 * among the helpers a generator wrote with it; the first line without a grammar or a declaration.
 */
export async function largestDeclaration(text: string, extension: string, start: number, end: number): Promise<number> {
    const grammar = MARKER_LANGUAGES[extension]?.grammar;
    const tree = grammar && await parse(text, grammar);
    if (!tree) return start;
    const inside = (node: Node) => node.startPosition.row >= start - 1 && node.endPosition.row <= end - 1;
    const outermost: Node[] = [];
    const visit = (node: Node) => {
        if (inside(node) && !isComment(node)) outermost.push(node);
        else for (const child of node.namedChildren) if (child) visit(child);
    };
    visit(tree.rootNode);
    const size = (node: Node) => node.endPosition.row - node.startPosition.row;
    const largest = outermost.reduce<Node | undefined>((best, node) => (!best || size(node) > size(best) ? node : best), undefined);
    return largest ? largest.startPosition.row + 1 : start;
}

/** Folder names never searched for markers: dependencies, build output, caches and dot folders. */
const SKIPPED = new Set(['node_modules', '_build', 'deps', 'target', '__pycache__', 'dist', 'out', 'build', 'coverage', 'vendor', 'venv']);
const LARGEST = 2_000_000;

const cache = new Map<string, { mtime: number, size: number, markers: Promise<Marker[]> }>();

/** The markers of one file, read again only when it changed. */
export function markersOf(path: string): Promise<Marker[]> {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > LARGEST || !MARKER_LANGUAGES[extname(path)]) return Promise.resolve([]);
    const seen = cache.get(path);
    if (seen && seen.mtime === stat.mtimeMs && seen.size === stat.size) return seen.markers;
    const markers = findMarkers(readFileSync(path, 'utf8'), extname(path));
    cache.set(path, { mtime: stat.mtimeMs, size: stat.size, markers });
    return markers;
}

/** Every marker in the code files of the folders (absolute paths), each file once. */
export async function scanMarkers(folders: string[]): Promise<{ path: string, marker: Marker }[]> {
    const files = new Set<string>();
    const walk = (folder: string) => {
        for (const entry of readdirSync(folder, { withFileTypes: true })) {
            if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED.has(entry.name)) walk(join(folder, entry.name));
            else if (entry.isFile() && MARKER_LANGUAGES[extname(entry.name)]) files.add(join(folder, entry.name));
        }
    };
    for (const folder of folders) if (existsSync(folder) && statSync(folder).isDirectory()) walk(resolve(folder));
    const all = await Promise.all([...files].sort().map(async path => (await markersOf(path)).map(marker => ({ path, marker }))));
    return all.flat();
}

/** The marker line for an element, indented like the line it goes above. */
export function markerLine(path: string, qn: string, fingerprint: string | undefined, indent: string): string {
    const syntax = MARKER_LANGUAGES[extname(path)];
    if (!syntax) throw new Error(`${basename(path)}: no comment syntax known for ${extname(path) || 'files without an extension'}.`);
    return `${indent}${syntax.comment} @appling ${qn}${fingerprint ? ` ${fingerprint}` : ''}`;
}

/**
 * Puts the marker of an element above the declaration that starts on a line of a file, or renews the fingerprint of
 * the marker it has there. Returns the declaration's range as it is afterwards.
 */
export async function writeMarker(path: string, line: number, qn: string, fingerprint?: string): Promise<{ start: number, end: number }> {
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n');
    if (!(line >= 1 && line <= lines.length)) throw new Error(`Line ${line} is outside ${basename(path)}, which has ${lines.length} lines.`);
    if (!lines[line - 1].trim()) throw new Error(`Line ${line} of ${basename(path)} is empty; give the line that declares the code.`);
    const own = (await findMarkers(text, extname(path))).find(m => m.qn === qn && m.start === line);
    if (own) {
        lines[own.line - 1] = lines[own.line - 1].replace(/(@appling\s+\S+)(?:\s+[0-9a-f]{8})?/, `$1${fingerprint ? ` ${fingerprint}` : ''}`);
        write(path, lines.join('\n'));
        return { start: own.start, end: own.end };
    }
    const indent = /^\s*/.exec(lines[line - 1])![0];
    lines.splice(line - 1, 0, markerLine(path, qn, fingerprint, indent));
    const next = lines.join('\n');
    const placed = (await findMarkers(next, extname(path))).find(m => m.qn === qn && m.line === line);
    if (!placed || placed.start !== line + 1) throw new Error(`Line ${line} of ${basename(path)} starts no declaration a marker can go above.`);
    write(path, next);
    return { start: placed.start, end: placed.end };
}

/** Removes marker lines (from 1) from a file. */
export function removeMarkerLines(path: string, lines: number[]): void {
    const drop = new Set(lines);
    write(path, readFileSync(path, 'utf8').split('\n').filter((_, i) => !drop.has(i + 1)).join('\n'));
}

/** Writes a file and forgets its markers: a write within the same clock tick may keep size and time. */
function write(path: string, text: string): void {
    writeFileSync(path, text);
    cache.delete(path);
}
