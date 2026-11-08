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

/** A Python docstring holding a node's `does` text, as lines at the given indentation; none without a text. */
export function docstring(node: GraphNode, indent: string): string[] {
    const text = node.data.does;
    if (typeof text !== 'string' || !text.trim()) return [];
    const escaped = text.replace(/\\/g, '\\\\').replace(/"(?="")|"$/g, '\\"');
    const lines = escaped.split('\n');
    if (lines.length === 1) return [`${indent}"""${escaped}"""`];
    return [`${indent}"""${lines[0]}`, ...lines.slice(1).map(l => l ? indent + l : ''), `${indent}"""`];
}

/** Puts the node's docstring under the first `class` or `def` line of the code. */
export function documented(code: string, node: GraphNode): string {
    const lines = code.split('\n');
    const at = lines.findIndex(l => /^\s*(class|def) .*:$/.test(l));
    if (at < 0) return code;
    const indent = `${lines[at].match(/^\s*/)![0]}    `;
    return [...lines.slice(0, at + 1), ...docstring(node, indent), ...lines.slice(at + 1)].join('\n');
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

const STANDARD_LIBRARY = ['contextvars', 'datetime', 'decimal', 'itertools', 're', 'typing', 'uuid'];

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

/** Adds routes to a URL module of an app, `<app>/<file>.py`, whose views live in `<app>/<views>.py`. */
export function routesStep(app: string, file: string, views: string, routes: string[]): Step {
    return template(`${app}/${file}.py`, existing => existing
        ? existing.replace(/\n\]\n$/, `\n${routes.join('\n')}\n]\n`)
        : pythonFile(undefined, ['from django.urls import path', `from ${app} import ${views}`], `urlpatterns = [\n${routes.join('\n')}\n]`));
}

/** Mounts a URL module of an app in `config/urls.py` under a prefix, such as "api/" or "" for the site root. */
export function includeStep(app: string, file: string, prefix: string): Step {
    const line = `path(${JSON.stringify(prefix)}, include(${JSON.stringify(`${app}.${file}`)})),`;
    return template('config/urls.py', existing => existing!.includes(line) ? existing! : existing!
        .replace('from django.urls import path', 'from django.urls import include, path')
        .replace(/urlpatterns = \[\n([\s\S]*?)\]/, (_, paths) => `urlpatterns = [\n${paths}    ${line}\n]`));
}

/** Imports `<app>/<file>.py` in the app's `AppConfig.ready`, so its receivers are connected when Django starts. */
export function importOnReady(module: string, file: string): Step {
    const line = `        from . import ${file}  # noqa: F401`;
    return template(`${appOf(module)}/apps.py`, existing => existing!.includes(line)
        ? existing!
        : existing!.includes('def ready(')
            ? existing!.replace(/( +def ready\(self\):\n)/, `$1${line}\n`)
            : `${existing!.trimEnd()}\n\n    def ready(self):\n${line}\n`);
}
