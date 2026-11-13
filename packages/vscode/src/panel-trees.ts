import type { GenerationEvent, GenerationSelection } from '@appling/codegen';
import { IMPLEMENTATION_STATES } from '@appling/model/implementation';
import { anchorOwner, isAnchorAddress } from '@appling/model/anchors';
import type { ElementChange, GraphDiff } from '@appling/model/diff';
import { Simulator, type Access, type Verdict } from '@appling/model/simulator';
import { claimOf, type PanelAction, type PanelState } from '@appling/ide/panels';
import {
    abilities, actionSummary, entityActions, IMPLEMENTATION_LABELS, kindLabel, LAYER_LABELS, memberText, policyText, relations,
    type GraphIndex
} from '@appling/viz/views';

/**
 * The side panels of the IDE as trees for the Appling sidebar in VS Code, VS Code free: each panel's nodes from the state the IDE
 * client sends (`@appling/ide/panels`). A node's `run` is what a click does, its `actions` what its inline buttons do.
 */

export interface PanelNode {
    /** Unique in its tree and stable across updates, so folded and unfolded nodes stay so. */
    id: string;
    label: string;
    description?: string;
    tooltip?: string;
    /** A codicon, optionally in a theme colour. */
    icon?: string;
    color?: string;
    /** How the element or file changed: VS Code decorates its label as Source Control does (a letter and a colour). */
    status?: ChangeStatus;
    /** A file relative to the project: its file icon. */
    file?: string;
    run?: Run;
    actions?: Partial<Record<Verb, Run>>;
    children?: PanelNode[];
    expanded?: boolean;
    checked?: boolean;
}

export const VERBS = ['accept', 'revert', 'reject', 'diff', 'generate', 'edit', 'add', 'remove'] as const;
export type Verb = typeof VERBS[number];

export type Run =
    | { type: 'action', action: PanelAction }
    /** A code file's lines, relative to the project. */
    | { type: 'code', path: string, start: number, end: number }
    | { type: 'source', qn: string }
    /** The text diff of a changed element: from the revision while the review marks, else the live file's. */
    | { type: 'textDiff', qn: string }
    | { type: 'liveDiff', path: string }
    | { type: 'reviewDiff', path: string, from?: string }
    | { type: 'reject', proposal: string }
    /** Edit, add or remove one line of a property (`line` undefined adds one; a plain value has one line). */
    | { type: 'line', qn: string, property: string, lines: string[], line?: number, remove?: boolean, separator: string }
    | { type: 'log' }
    /** Generate without a target: ask for the stack first. */
    | { type: 'stack', selection: GenerationSelection };

type Builder = (state: PanelState, index: GraphIndex) => PanelNode[];

/** The panels the sidebar shows; search is VS Code's own (Go to Symbol in Workspace, from the language server). */
export const VIEWS = ['inspector', 'changes', 'review', 'code', 'tasks'] as const;
export type ViewName = typeof VIEWS[number];

/**
 * The elements asked for on the canvas, waiting for an agent to model them, then the open tasks of every target's
 * registry: what the generated code still misses, for an agent or you to finish.
 */
function tasksTree(state: PanelState, index: GraphIndex): PanelNode[] {
    const snapshot = state.snapshot;
    const requests = group('requests', 'Requested elements', snapshot.requests.map(r => ({
        id: `request/${r.id}`, label: r.name, description: `${r.kind ? `${kindLabel(r.kind)} ` : ''}${r.parentRequest ? `on the requested ${snapshot.requests.find(p => p.id === r.parentRequest)?.name}` : r.parent ? `under ${r.parent}` : 'in the model'} · ${r.taken ? 'taken by an agent' : 'waiting for an agent'}`,
        tooltip: r.description, icon: 'lightbulb', ...r.parent ? { run: { type: 'action', action: { type: 'select', qn: r.parent } } as Run } : {}
    })), true, String(snapshot.requests.length));
    if (!snapshot.targets.length) return requests;
    return [...requests, ...registryTasks(state, index)];
}

function registryTasks(state: PanelState, index: GraphIndex): PanelNode[] {
    const snapshot = state.snapshot;
    const open = snapshot.tasks.filter(t => t.status !== 'done');
    const byTarget = (target: string) => open.filter(t => t.target === target).map(task => {
        const claim = claimOf(state.sessions, task.qn);
        return {
            ...element(`task/${task.target}/${task.qn}`, index, task.qn, [task.status, `${task.attempts} attempt${task.attempts === 1 ? '' : 's'}`, claim && (claim.label ?? claim.name)].filter(Boolean).join(' · ')),
            tooltip: [...task.missing, ...task.notes].join('\n'),
            expanded: false,
            children: [
                ...task.missing.map((m, i) => ({ id: `task/${task.target}/${task.qn}/missing/${i}`, label: m, icon: 'circle-large-outline' })),
                ...task.notes.map((n, i) => ({ id: `task/${task.target}/${task.qn}/note/${i}`, label: n, icon: 'note' }))
            ]
        };
    });
    if (snapshot.targets.length === 1) return byTarget(snapshot.targets[0].out);
    return snapshot.targets.flatMap(t => group(`target/${t.out}`, `${t.extension} → ${t.out}`, byTarget(t.out), true, String(open.filter(task => task.target === t.out).length)));
}

export const PANEL_TREES: Record<ViewName, Builder> = {
    inspector: inspectorTree,
    changes: changesTree,
    review: reviewTree,
    code: codeTree,
    tasks: tasksTree
};

const select = (qn: string): Run => ({ type: 'action', action: { type: 'select', qn } });

/** An element: its name (or `label`), what it is, and a click selects it on the canvas. */
function element(id: string, index: GraphIndex, qn: string, description?: string, label = qn): PanelNode {
    const node = index.nodes.get(qn);
    return { id, label, description: description ?? (node && kindLabel(node.kind)), tooltip: qn, icon: node ? iconOf(node.kind) : 'symbol-misc', run: select(qn) };
}

function group(id: string, label: string, children: PanelNode[], expanded = true, description?: string): PanelNode[] {
    return children.length ? [{ id, label, description, children, expanded }] : [];
}

const ICONS: Record<string, string> = {
    Module: 'symbol-namespace', Entity: 'symbol-class', Value: 'symbol-structure', Field: 'symbol-field', Param: 'symbol-parameter',
    Enum: 'symbol-enum', Literal: 'symbol-enum-member', Action: 'symbol-method', Event: 'symbol-event', Error: 'error',
    Machine: 'symbol-constructor', Query: 'search', Invariant: 'law', Policy: 'shield', Actor: 'person', Role: 'organization',
    UseCase: 'list-ordered', Endpoint: 'globe', Page: 'window', Job: 'clock', External: 'plug', Migration: 'history'
};

export function iconOf(kind: string): string {
    return ICONS[kind] ?? 'symbol-misc';
}

const STATE_COLORS: Record<string, string> = {
    implemented: 'charts.green', partial: 'charts.yellow', unimplemented: 'disabledForeground', shifted: 'charts.orange', broken: 'charts.red'
};
export type ChangeStatus = 'added' | 'changed' | 'removed' | 'modified' | 'deleted' | 'renamed' | 'untracked';

/** The changes the canvas marks: the review's while it marks, else the live ones. */
export function canvasChanges(state: PanelState): GraphDiff | undefined {
    const review = state.review;
    if (review.on && review.marked && review.result?.ok) return review.result.diff;
    return state.live?.files.length ? state.live.diff : undefined;
}

/** The element the inspector shows: a selected sub-anchor shows its element. */
export function inspected(state: PanelState, index: GraphIndex): { qn?: string, anchor?: string } {
    const selected = state.selected;
    if (!selected) return {};
    const qn = !index.nodes.has(selected) && isAnchorAddress(selected) ? anchorOwner(selected) : selected;
    return { qn, anchor: qn !== selected ? selected : undefined };
}

const TYPED = new Set(['Field', 'Param']);
const VERDICTS: Record<Verdict, string> = { yes: 'may', no: 'may not', depends: 'depends on the data' };

/** The editable properties of an element, as the inspector's form has them. */
export function editableProps(index: GraphIndex, qn: string): [string, unknown][] {
    const node = index.nodes.get(qn);
    return node ? Object.entries(node.props).filter(([key, value]) => typeof value !== 'boolean' && !(TYPED.has(node.kind) && key === 'type')) : [];
}

function inspectorTree(state: PanelState, index: GraphIndex): PanelNode[] {
    const { qn, anchor } = inspected(state, index);
    const node = qn ? index.nodes.get(qn) : undefined;
    if (!qn || !node) return [];
    const snapshot = state.snapshot;
    const code = snapshot.code[qn] ?? [];
    const implementation = snapshot.implementation[qn];
    const change = canvasChanges(state)?.changes.find(c => c.qn === qn);
    const running = !!state.run && !state.run.ended;
    const nodes: PanelNode[] = [{
        id: 'head', label: qn, description: `${node.props.link ? 'link ' : ''}${kindLabel(node.kind)} · ${LAYER_LABELS[node.layer]}`, tooltip: 'Open the source',
        icon: iconOf(node.kind), run: { type: 'source', qn }
    }];
    if (anchor) {
        const state = snapshot.anchors[anchor];
        const refs = snapshot.code[anchor] ?? [];
        nodes.push({
            id: 'anchor', label: `line ${anchor.slice(qn.length)}`, icon: 'symbol-key',
            description: [state && IMPLEMENTATION_LABELS[state.state], !refs.length && "the element's code covers it"].filter(Boolean).join(' · '),
            run: refs[0] && { type: 'code', path: refs[0].file, start: refs[0].start, end: refs[0].end }
        });
    }
    if (change) {
        nodes.push({
            id: 'change', label: change.status, icon: 'diff', status: change.status, tooltip: 'Open the text diff',
            description: [change.was && `from ${change.was}`, change.status === 'changed' && change.props.join(', ')].filter(Boolean).join(' · '),
            run: { type: 'textDiff', qn }
        });
    }
    if (implementation) {
        const selection = { mode: 'elements' as const, elements: [qn] };
        const generateRun = (selection: GenerationSelection): Run => snapshot.targets.length ? { type: 'action', action: { type: 'generate', selection } } : { type: 'stack', selection };
        // the application comes first: until it exists, only that generates
        const generated = snapshot.targets.some(t => t.generated);
        const generate = running || !generated ? undefined : generateRun(selection);
        const tasks = snapshot.tasks.filter(t => t.qn === qn && t.status !== 'done');
        nodes.push({
            id: 'implementation', label: IMPLEMENTATION_LABELS[implementation.state], icon: 'circle-filled', color: STATE_COLORS[implementation.state],
            description: [implementation.tasks && `${implementation.tasks} open task${implementation.tasks > 1 ? 's' : ''}`, implementation.outstanding && 'changed since the last generation'].filter(Boolean).join(' · '),
            actions: generate && { generate },
            children: [
                ...code.map((c, i) => ({
                    id: `code/${i}`, label: `${c.file}:${c.start}-${c.end}`, description: c.status === 'current' ? undefined : c.status, file: c.file, tooltip: c.text,
                    run: { type: 'code', path: c.file, start: c.start, end: c.end } as Run
                })),
                ...!generated && !running ? [{ id: 'generate-application', label: 'Generate the application first', description: 'then elements one by one', icon: 'run-all', run: generateRun({ mode: 'all' }) }] : [],
                ...tasks.flatMap(t => t.missing.map((m, i) => ({ id: `task/${t.target}/${i}`, label: m, description: `task · ${t.target}`, icon: 'circle-large-outline', run: { type: 'action', action: { type: 'select', qn } } as Run })))
            ],
            expanded: true
        });
    }
    const link = (id: string, target: string, description?: string, label?: string) => element(id, index, target, description, label);
    if (node.kind === 'Action') {
        const summary = actionSummary(index, qn);
        const rows: [string, string | undefined][] = [
            ['Input', summary.inputs.join('; ')], ['Requires', summary.requires.join('; ')], ['Changes', summary.changes.join('; ') || 'nothing in the model'],
            ['Errors', summary.errors.join(', ')], ['Consistency', summary.consistency]
        ];
        nodes.push(...group('does', 'What it does', [
            ...summary.on ? [link('does/on', summary.on, 'on')] : [],
            ...rows.filter(([, value]) => value).map(([label, value]) => ({ id: `does/${label}`, label, description: value, tooltip: value }))
        ]));
        const simulator = new Simulator(index.graph);
        nodes.push(...group('who', 'Who may trigger it', simulator.actors(qn).filter(a => a.verdict !== 'no').map(a => link(`who/${a.actor}`, a.actor, VERDICTS[a.verdict]))));
        nodes.push(...group('risks', 'Invariants at risk', simulator.risks(qn).map(r => link(`risk/${r.invariant}`, r.invariant, `reads ${r.fields.join(', ')}`))));
    }
    if (node.kind === 'Actor') {
        const groups = abilities(index, new Simulator(index.graph).access(qn));
        const ability = (prefix: string, entry: Access & { offers?: Access[] }): PanelNode => ({
            ...link(`${prefix}/${entry.target}/${entry.operation ?? ''}/${entry.fields ?? ''}`, entry.target, [entry.operation, entry.fields && `fields ${entry.fields.join(', ')}`, VERDICTS[entry.verdict]].filter(Boolean).join(' ')),
            children: [
                ...entry.policies.length ? entry.policies.map(p => link(`${prefix}/${entry.target}/policy/${p}`, p, 'policy', policyText(index, p))) : [{ id: `${prefix}/${entry.target}/none`, label: 'no policy' }],
                ...(entry.offers ?? []).filter(o => o.verdict !== 'no').map(o => link(`${prefix}/${entry.target}/offers/${o.target}`, o.target, `offers · ${VERDICTS[o.verdict]}`))
            ]
        });
        nodes.push(...group('can', 'What they can do', [...groups].flatMap(([label, entries]) => group(`can/${label}`, label,
            entries.filter(e => e.verdict !== 'no').sort((a, b) => Number(a.verdict === 'depends') - Number(b.verdict === 'depends')).map(e => ability(`can/${label}`, e))))));
    }
    if (node.kind === 'Entity') {
        nodes.push(...group('actions', 'Actions', entityActions(index, qn).map(a => link(`action/${a.qn}`, a.qn, [a.creates ? 'creates' : '', ...a.transitions].filter(Boolean).join(', ')))));
    }
    if (node.kind === 'Machine') {
        const simulator = new Simulator(index.graph);
        const field = index.nodes.get(String(node.data.field));
        const states = field ? index.children(String((field.data.type as { decl?: string }).decl)).map(l => l.qn.slice(l.qn.lastIndexOf('.') + 1)) : [];
        nodes.push(...group('states', 'Reachable states', states.map(s => {
            const reach = simulator.reach(qn, s);
            return { id: `state/${s}`, label: s, description: reach ? (reach.path.length ? `via ${reach.path.map(p => p.trigger).join(', ')}` : 'initial') : 'unreachable' };
        })));
    }
    nodes.push(...group('props', 'Properties', editableProps(index, qn).map(([key, value]) => {
        const separator = key === 'modifiers' ? ' ' : '\n';
        const lines = Array.isArray(value) ? value.map(String) : [String(value)];
        const edit = (line?: number, remove?: boolean): Run => ({ type: 'line', qn, property: key, lines, line, remove, separator });
        if (!Array.isArray(value) || separator === ' ') return { id: `prop/${key}`, label: key, description: lines.join(separator), tooltip: lines.join(separator), run: edit(0), actions: { edit: edit(0) } };
        return {
            id: `prop/${key}`, label: key, description: String(lines.length), actions: { add: edit() }, expanded: true,
            children: lines.map((text, i) => ({ id: `prop/${key}/${i}`, label: text, tooltip: text, run: edit(i), actions: { edit: edit(i), remove: edit(i, true) } }))
        };
    }), false));
    nodes.push(...group('members', 'Members', index.children(qn).map(c => link(`member/${c.qn}`, c.qn, kindLabel(c.kind), memberText(c, index)))));
    for (const [direction, title] of [['usedBy', 'Used by'], ['uses', 'Uses']] as const) {
        const byLayer = relations(index, qn, direction);
        nodes.push(...group(direction, title, [...byLayer].flatMap(([layer, items]) => group(`${direction}/${layer}`, LAYER_LABELS[layer],
            items.map(r => link(`${direction}/${layer}/${r.qn}`, r.qn, `${kindLabel(r.kind)}${r.via.length ? ` via ${r.via.join(', ')}` : ''}`))))));
    }
    return nodes;
}

function sessionName(state: PanelState, id: string): string {
    const session = state.sessions.find(s => s.id === id);
    return session ? session.label ?? session.name : 'ended session';
}

/** The changed elements of a diff, each selecting its element. */
function changeNodes(prefix: string, index: GraphIndex, changes: (ElementChange | undefined)[], details: (c: ElementChange) => string | undefined, diff?: (c: ElementChange) => Run): PanelNode[] {
    return changes.filter((c): c is ElementChange => !!c).map(c => ({
        ...element(`${prefix}/${c.status}/${c.qn}`, index, c.qn, details(c)),
        status: c.status,
        actions: diff && { diff: diff(c) }
    }));
}

function changesTree(state: PanelState, index: GraphIndex): PanelNode[] {
    const proposals = state.proposals.map((p): PanelNode => ({
        id: `proposal/${p.id}`, label: p.review.summary, description: `${sessionName(state, p.session)} proposes`, icon: 'git-pull-request', tooltip: p.review.summary, expanded: true,
        actions: { accept: { type: 'action', action: { type: 'decide', id: p.id, decision: { accepted: true } } }, reject: { type: 'reject', proposal: p.id } },
        children: [
            ...p.review.hunks.map((h, i) => ({
                id: `proposal/${p.id}/hunk/${i}`, label: `${h.file}:${h.line}`, file: h.file, description: `+${h.added.length} −${h.removed.length}`,
                tooltip: [...h.removed.map(l => `- ${l}`), ...h.added.map(l => `+ ${l}`)].join('\n')
            })),
            ...p.review.graph.added.map(qn => ({ ...element(`proposal/${p.id}/added/${qn}`, index, qn), status: 'added' as const })),
            ...p.review.graph.changed.map(qn => ({ ...element(`proposal/${p.id}/changed/${qn}`, index, qn), status: 'changed' as const })),
            ...p.review.graph.removed.map(qn => ({ id: `proposal/${p.id}/removed/${qn}`, label: qn, icon: 'symbol-misc', status: 'removed' as const }))
        ]
    }));
    const live = state.live;
    const changes = new Map((live?.diff.changes ?? []).map(c => [c.qn, c]));
    const files = live?.files ?? [];
    return [
        ...group('proposals', 'Proposed changes', proposals),
        ...files.map((f): PanelNode => ({
            id: `file/${f.path}`, label: f.path, file: f.path, status: f.status,
            description: `${f.sessions.length ? f.sessions.map(id => sessionName(state, id)).join(', ') : 'written to disk'} · ${new Date(f.at).toLocaleTimeString()}`,
            tooltip: `${f.path}\n${new Date(f.at).toLocaleString()}`,
            run: { type: 'liveDiff', path: f.path },
            actions: { accept: { type: 'action', action: { type: 'accept', paths: [f.path] } }, revert: { type: 'action', action: { type: 'revert', path: f.path } } },
            children: changeNodes(`file/${f.path}`, index, f.elements.map(qn => changes.get(qn)),
                c => `${c.status} ${kindLabel(c.kind)}${c.status === 'changed' && c.props.length ? ` · ${c.props.join(', ')}` : ''}`),
            expanded: true
        }))
    ];
}

/** "2 added · 1 changed · 0 removed" */
export function diffSummary(diff: GraphDiff): string {
    return `${diff.added.length} added · ${diff.changed.length} changed · ${diff.removed.length} removed`;
}

function reviewTree(state: PanelState, index: GraphIndex): PanelNode[] {
    const result = state.review.result;
    if (!result) return [{ id: 'reading', label: 'Reading git…', icon: 'loading~spin' }];
    if (!result.ok) return [{ id: 'error', label: result.error, icon: 'warning', tooltip: result.error }];
    const details = (c: ElementChange) => [
        `${c.status}${c.was ? ` from ${c.was}` : ''} ${kindLabel(c.kind)}`,
        c.status === 'changed' && c.props.join(', '),
        c.status === 'changed' && c.edges.added.length + c.edges.removed.length > 0 && `${c.edges.added.length + c.edges.removed.length} reference(s)`
    ].filter(Boolean).join(' · ');
    const model = changeNodes('model', index, result.diff.changes.slice(0, 300), details, c => ({ type: 'action', action: { type: 'textDiff', qn: c.qn } }));
    return [
        ...model.length ? group('model', 'Model', model, true, diffSummary(result.diff)) : [{ id: 'model', label: 'The model has not changed.' }],
        ...group('files', 'Files', result.files.map(f => ({
            id: `file/${f.path}`, label: f.path, file: f.path, status: f.status,
            tooltip: f.from ? `${f.from} → ${f.path}` : f.path, run: { type: 'reviewDiff', path: f.path, from: f.from } as Run
        })))
    ];
}

function codeTree(state: PanelState, index: GraphIndex): PanelNode[] {
    const snapshot = state.snapshot;
    const states = Object.entries(snapshot.implementation);
    const outstanding = states.filter(([, i]) => i.outstanding).map(([qn]) => qn);
    const tops = outstanding.filter(qn => !outstanding.some(other => qn.startsWith(`${other}.`)));
    const run = state.run;
    const nodes: PanelNode[] = [{
        id: 'implementation', label: 'Implementation',
        children: IMPLEMENTATION_STATES.map(s => ({ id: `state/${s}`, label: IMPLEMENTATION_LABELS[s], description: String(states.filter(([, i]) => i.state === s).length), icon: 'circle-filled', color: STATE_COLORS[s] })),
        expanded: false
    }];
    nodes.push(snapshot.targets.length
        ? { id: 'targets', label: 'Targets', expanded: true, children: snapshot.targets.map(t => ({ id: `target/${t.out}`, label: `${t.extension} → ${t.out}`, icon: 'package', description: t.generated ? (t.at ? `generated ${new Date(t.at).toLocaleString()}` : 'generated') : 'not generated yet' })) }
        : { id: 'targets', label: 'No targets', icon: 'info', tooltip: 'Add "generate": [{ "extension": "@appling/codegen-django", "out": "app" }] to appling.config.json.' });
    nodes.push(...group('outstanding', 'New or changed since the last generation', tops.slice(0, 300).map(qn => ({
        ...element(`outstanding/${qn}`, index, qn, IMPLEMENTATION_LABELS[snapshot.implementation[qn].state]), checked: false
    })), false, String(tops.length)));
    if (run) {
        const of = <T extends GenerationEvent['type']>(type: T) => run.events.filter((e): e is Extract<GenerationEvent, { type: T }> => e.type === type);
        const failed = of('failed');
        const generated = of('generated').flatMap(e => e.elements);
        const tasks = of('tasks').flatMap(e => e.tasks);
        const steps = of('planned').reduce((sum, e) => sum + e.steps.length, 0);
        const bad = !!of('done')[0]?.failed || failed.length > 0;
        nodes.push({
            id: `run/${run.id}`, label: run.title, icon: !run.ended ? 'loading~spin' : bad ? 'error' : 'pass', color: bad ? 'errorForeground' : undefined, expanded: true,
            description: `${!run.ended ? 'running' : bad ? 'failed' : 'done'} · ${steps} planned · ${generated.length} generated · ${tasks.length} with open tasks`,
            children: [
                ...failed.map((f, i) => ({ id: `run/failed/${i}`, label: `${f.target ? `${f.target}: ` : ''}${f.message}`, tooltip: f.message, icon: 'error', color: 'errorForeground' })),
                ...of('skipped').map(s => ({ id: `run/skipped/${s.target}`, label: s.target, description: s.reason, icon: 'debug-step-over' })),
                ...tasks.map(t => element(`run/task/${t.qn}`, index, t.qn, t.missing.join('; '))),
                { id: 'run/log', label: 'Log', icon: 'output', run: { type: 'log' } }
            ]
        });
    }
    return nodes;
}
