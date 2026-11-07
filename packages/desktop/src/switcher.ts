import type { Workspaces } from './workspaces.js';

/** A match of a query in a text: higher scores are better; `positions` are the matched character indexes. */
export interface Match {
    score: number;
    positions: number[];
}

/** One line of the switcher: a repo in one workspace (a repo in two workspaces gives two lines). */
export interface SwitcherEntry {
    repo: string;
    workspace: string;
    name: string;
    workspaceName: string;
    /** Matched character indexes in `name`. */
    positions: number[];
    active: boolean;
    hidden: boolean;
}

const SEPARATOR = /[-_.\s/\\]/;

/** Whether a character starts a word: the first one, one after a separator, or an upper case letter after a lower case one. */
function wordStart(text: string, at: number): boolean {
    if (at === 0) return true;
    const previous = text[at - 1];
    return SEPARATOR.test(previous) || (/[a-z0-9]/.test(previous) && /[A-Z]/.test(text[at]));
}

/**
 * Matches the query's characters in order, ignoring case and spaces in the query, as VS Code's quick open does, and
 * picks the alignment with the best score: every matched character counts, more at a word start, after the previous
 * match (a run), with the same case, and at the very start. Shorter texts win among equal matches. Returns
 * `undefined` when not every character is found. Names are short, so the quadratic search per character is cheap.
 */
export function fuzzyMatch(query: string, text: string): Match | undefined {
    const needle = query.replace(/\s+/g, '');
    if (!needle) return { score: 0, positions: [] };
    const lower = needle.toLowerCase();
    const haystack = text.toLowerCase();
    const gain = (i: number, j: number) => 1 + (wordStart(text, j) ? 8 : 0) + (text[j] === needle[i] ? 1 : 0) + (j === 0 ? 3 : 0);
    // best[i][j]: the best score of matching needle[0..i] with needle[i] at text[j]; from[i][j]: where needle[i - 1] sits then
    const best: number[][] = [];
    const from: number[][] = [];
    for (let i = 0; i < lower.length; i++) {
        best.push(new Array(text.length).fill(-Infinity));
        from.push(new Array(text.length).fill(-1));
        for (let j = i; j < text.length; j++) {
            if (haystack[j] !== lower[i]) continue;
            if (i === 0) {
                best[i][j] = gain(i, j);
                continue;
            }
            for (let k = i - 1; k < j; k++) {
                const score = best[i - 1][k] + gain(i, j) + (k === j - 1 ? 5 : 0);
                if (score > best[i][j]) {
                    best[i][j] = score;
                    from[i][j] = k;
                }
            }
        }
    }
    const last = lower.length - 1;
    let end = -1;
    for (let j = 0; j < text.length; j++) if (best[last][j] > (end < 0 ? -Infinity : best[last][end])) end = j;
    if (end < 0 || best[last][end] === -Infinity) return undefined;
    const positions: number[] = [];
    for (let i = last, j = end; i >= 0; j = from[i][j], i--) positions.unshift(j);
    return { score: best[last][end] - text.length / 100, positions };
}

/**
 * The switcher's lines for a query over every repo of every open workspace, best first. An empty query lists them
 * in most recently used order with the shown repo last, so Enter goes to the previous one. A query matches the
 * repo's name, or failing that `workspace/name`; ties go to the more recently used repo.
 */
export function switcherEntries(workspaces: Workspaces, nameOf: (repo: string, folderName?: string) => string, query: string): SwitcherEntry[] {
    const recent = workspaces.mostRecent();
    const rank = (repo: string) => {
        const at = recent.indexOf(repo);
        return at < 0 ? recent.length : at;
    };
    const shown = workspaces.activeRepo();
    const entries: (SwitcherEntry & { score: number })[] = [];
    for (const workspace of workspaces.all()) {
        for (const folder of workspace.folders) {
            const name = nameOf(folder.path, folder.name);
            const active = workspace.id === workspaces.active && folder.path === shown;
            const base = { repo: folder.path, workspace: workspace.id, name, workspaceName: workspace.name, active, hidden: workspace.hidden.includes(folder.path) };
            const own = fuzzyMatch(query, name);
            if (own) {
                entries.push({ ...base, positions: own.positions, score: own.score });
                continue;
            }
            const prefix = `${workspace.name}/`;
            const full = fuzzyMatch(query, `${prefix}${name}`);
            if (full) entries.push({ ...base, positions: full.positions.filter(p => p >= prefix.length).map(p => p - prefix.length), score: full.score - 20 });
        }
    }
    const empty = !query.trim();
    entries.sort((a, b) => empty
        ? Number(a.active) - Number(b.active) || rank(a.repo) - rank(b.repo)
        : b.score - a.score || rank(a.repo) - rank(b.repo));
    return entries.map(({ score: _, ...entry }) => entry);
}
