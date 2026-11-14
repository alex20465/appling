import { readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { findMarkers, largestDeclaration, markerLine, MARKER_LANGUAGES } from '@appling/model';
import { locateWritten, type Written } from './written.js';

const COMMENT_LINE = /^\s*(?:#|\/\/|--|\/\*|\*)/;

/**
 * Puts an `@appling <qn> <fingerprint>` marker above the code each element got: the largest declaration of what its steps
 * wrote, once every step ran. A marker that would not mark that code (it landed in a string, or the file's language has no
 * comments) is left out. Returns the number of markers.
 */
export async function markWritten(out: string, written: Written[], fingerprints: Record<string, string>): Promise<number> {
    const byFile = Map.groupBy(Object.entries(locateWritten(out, written)).flatMap(([qn, ranges]) => fingerprints[qn] ? ranges.map(r => ({ qn, ...r })) : []), r => r.file);
    let count = 0;
    for (const [file, ranges] of byFile) {
        if (!MARKER_LANGUAGES[extname(file)]) continue;
        const path = join(out, file);
        const text = readFileSync(path, 'utf8');
        const lines = text.split('\n');
        const placed = await Promise.all(ranges.map(async r => ({ qn: r.qn, start: await largestDeclaration(text, extname(file), r.start, r.end) })));
        const seen = new Set<string>();
        // from the bottom up, so the lines below stay where they were found; markers of one line stack in element order
        const inserted: number[] = [];
        for (const { qn, start } of placed.sort((a, b) => b.start - a.start || b.qn.localeCompare(a.qn))) {
            if (seen.has(`${qn} ${start}`)) continue;
            seen.add(`${qn} ${start}`);
            lines.splice(start - 1, 0, markerLine(path, qn, fingerprints[qn], /^\s*/.exec(lines[start - 1])![0]));
            for (let i = 0; i < inserted.length; i++) if (inserted[i] >= start) inserted[i]++;
            inserted.push(start);
        }
        const markers = new Set(inserted);
        const found = new Map((await findMarkers(lines.join('\n'), extname(file))).map(m => [m.line, m]));
        const failed = inserted.filter(line => {
            const marker = found.get(line);
            if (!marker) return true;
            let code = line + 1;
            while (markers.has(code) || (code < marker.start && COMMENT_LINE.test(lines[code - 1]))) code++;
            return marker.start !== code;
        });
        const drop = new Set(failed);
        writeFileSync(path, lines.filter((_, i) => !drop.has(i + 1)).join('\n'));
        count += inserted.length - failed.length;
    }
    return count;
}
