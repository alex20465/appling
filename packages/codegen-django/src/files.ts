import type { MapContext, Step } from '@appling/codegen';
import type { GraphNode, TypeData } from '@appling/model';
import { appOf, lastOf } from './python.js';

const PYTHON_TYPES: Record<string, [string, string?]> = {
    String: ['str'], Text: ['str'], Int: ['int'], Bool: ['bool'], File: ['str'],
    Decimal: ['Decimal', 'from decimal import Decimal'], Money: ['Decimal', 'from decimal import Decimal'],
    Date: ['date', 'from datetime import date'], DateTime: ['datetime', 'from datetime import datetime'],
    Duration: ['timedelta', 'from datetime import timedelta'], Uuid: ['UUID', 'from uuid import UUID']
};

export function template(file: string, write: (existing: string | undefined) => string): Step {
    return { kind: 'template', file, write };
}

export function task(what: string): Step {
    return { kind: 'task', what };
}

/** Adds a block of code to a Python file, merging its imports into the file's import block. */
export function pythonFile(existing: string | undefined, imports: Iterable<string>, block: string): string {
    const lines = (existing ?? '').replace(/\n# Create your [a-z ]+ here\.\n/, '\n').split('\n');
    const end = lines.findIndex(l => l.trim() !== '' && !/^(from|import) /.test(l));
    const header = (end < 0 ? lines : lines.slice(0, end)).filter(l => l.trim() !== '');
    const body = (end < 0 ? [] : lines.slice(end)).join('\n').trim();
    return [mergeImports([...header, ...imports]).join('\n'), body, block].filter(Boolean).join('\n\n\n') + '\n';
}

const STANDARD_LIBRARY = ['datetime', 'decimal', 're', 'typing', 'uuid'];

/** One line per module with its names sorted; standard library first, then Django and REST framework, then the project's apps. */
function mergeImports(lines: string[]): string[] {
    const names = new Map<string, Set<string>>();
    const plain = new Set<string>();
    for (const line of lines) {
        const match = /^from (\S+) import (.+)$/.exec(line);
        if (!match) plain.add(line);
        else for (const name of match[2].split(',')) names.set(match[1], (names.get(match[1]) ?? new Set()).add(name.trim()));
    }
    const merged = [...plain, ...[...names].map(([module, list]) => `from ${module} import ${[...list].sort().join(', ')}`)];
    const rank = (line: string) => {
        const module = line.split(' ')[1].split('.')[0];
        return STANDARD_LIBRARY.includes(module) ? 0 : module === 'django' || module === 'rest_framework' ? 1 : 2;
    };
    const key = (line: string) => line.split(' ')[1];
    return merged.sort((a, b) => rank(a) - rank(b) || key(a).localeCompare(key(b)) || a.localeCompare(b));
}

/** The Python annotation of a type, adding the imports it needs. */
export function annotation(type: TypeData, context: MapContext, imports: Set<string>): string {
    let base = 'object';
    if (type.primitive) {
        const [name, line] = PYTHON_TYPES[type.primitive];
        if (line) imports.add(line);
        base = name;
    } else if (type.decl) {
        const decl = context.node(type.decl)!;
        base = lastOf(decl.qn);
        imports.add(`from ${appOf(decl.module)}.${decl.kind === 'Entity' ? 'models' : decl.kind === 'Enum' ? 'enums' : 'values'} import ${base}`);
    }
    const many = type.many ? `list[${base}]` : base;
    return type.optional ? `${many} | None` : many;
}

export function children(node: GraphNode, context: MapContext, kind?: string): GraphNode[] {
    return context.children(node.qn).filter(c => !kind || c.kind === kind);
}

export function hasKind(context: MapContext, ...kinds: string[]): boolean {
    return context.graph.nodes.some(n => kinds.includes(n.kind));
}
