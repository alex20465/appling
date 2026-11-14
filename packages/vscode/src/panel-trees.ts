import { anchorOwner, isAnchorAddress } from '@appling/model/anchors';
import type { ElementChange, GraphDiff } from '@appling/model/diff';
import { Simulator, type Access, type Verdict } from '@appling/model/simulator';
import { claimOf, type PanelAction, type PanelState } from '@appling/inspect/panels';
import {
    abilities, actionSummary, entityActions, IMPLEMENTATION_LABELS, kindLabel, LAYER_LABELS, memberText, plural, policyText, relations,
    type GraphIndex
} from '@appling/viz/views';

/**
 * The side panels of the inspector as trees for the Appling sidebar in VS Code, VS Code free and read only: each
 * panel's nodes from the state the inspector client sends (`@appling/inspect/panels`). A node's `run` is what a click
 * does, its `inspect` the element its inline button inspects.
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
    /** The element the row's inline button selects on the canvas, so the inspector shows it. */
    inspect?: string;
    children?: PanelNode[];
    expanded?: boolean;
}

export type Run =
    | { type: 'action', action: PanelAction }
    /** A code file's lines, relative to the project. */
    | { type: 'code', path: string, start: number, end: number }
    | { type: 'source', qn: string }
    /** The text diff of a changed element: from the revision while the review marks, else the live file's. */
    | { type: 'textDiff', qn: string }
    | { type: 'liveDiff', path: string };

type Builder = (state: PanelState, index: GraphIndex) => PanelNode[];

/** The panels the sidebar shows; search is VS Code's own (Go to Symbol in Workspace, from the language server). */
export const VIEWS = ['inspector', 'playbook', 'changes', 'tasks'] as const;
export type ViewName = typeof VIEWS[number];

/** The open tasks of every target's registry: what the generated code still misses, for an agent or you to finish. */
function tasksTree(state: PanelState, index: GraphIndex): PanelNode[] {
    return state.snapshot.targets.length ? registryTasks(state, index) : [];
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
    return snapshot.targets.flatMap(t => group(`target/${t.out}`, `${t.extension} → ${t.out}`, 'package', byTarget(t.out)));
}

/** The playbooks of the agent sessions: a click on a step plays it on the canvas. */
function playbookTree(state: PanelState, index: GraphIndex): PanelNode[] {
    return state.playbooks.map(book => {
        const session = state.sessions.find(s => s.id === book.session);
        return {
            id: `playbook/${book.session}`, label: book.title, description: session && (session.label ?? session.name), expanded: true,
            children: book.steps.map((step, i): PanelNode => ({
                id: `playbook/${book.session}/${i}`, label: `${i + 1}  ${step.title}`, description: step.target.split('.').at(-1), tooltip: step.text,
                icon: i === book.at ? 'play' : book.at !== undefined && i < book.at ? 'check' : iconOf(index.nodes.get(step.target)?.kind ?? ''),
                color: i === book.at ? 'charts.green' : undefined,
                run: { type: 'action', action: { type: 'step', session: book.session, step: i } }
            }))
        };
    });
}

export const PANEL_TREES: Record<ViewName, Builder> = {
    inspector: inspectorTree,
    playbook: playbookTree,
    changes: changesTree,
    tasks: tasksTree
};

const select = (qn: string): Run => ({ type: 'action', action: { type: 'select', qn } });

/** An element: its name (or `label`), what it is, and a click selects it on the canvas. */
function element(id: string, index: GraphIndex, qn: string, description?: string, label = qn): PanelNode {
    const node = index.nodes.get(qn);
    return { id, label, description: description ?? (node && kindLabel(node.kind)), tooltip: qn, icon: node ? iconOf(node.kind) : 'symbol-misc', run: select(qn) };
}

/** A group row with its icon and, unless `counted` is false, how many rows it holds (subgroups count their rows). */
function group(id: string, label: string, icon: string, children: PanelNode[], { expanded = true, counted = true } = {}): PanelNode[] {
    return children.length ? [{ id, label, icon, description: counted ? String(count(children)) : undefined, children, expanded }] : [];
}

function count(nodes: PanelNode[]): number {
    return nodes.reduce((sum, node) => sum + (node.run || !node.children ? 1 : count(node.children)), 0);
}

const ICONS: Record<string, string> = {
    Module: 'symbol-namespace', Role: 'organization', Actor: 'person', Tenant: 'home', Entity: 'symbol-class', Field: 'symbol-field',
    Policy: 'shield', Invariant: 'law', Enum: 'symbol-enum', EnumLiteral: 'symbol-enum-member', ValueType: 'symbol-structure',
    Event: 'symbol-event', Action: 'symbol-method', SetEffect: 'edit', EmitEffect: 'broadcast', ErrorDecl: 'error', Param: 'symbol-parameter',
    Machine: 'symbol-constructor', Transition: 'arrow-right', Job: 'clock', Query: 'search', Projection: 'eye', ProjectionField: 'symbol-field',
    External: 'plug', ExternalOperation: 'symbol-function', UseCase: 'list-ordered', Interface: 'symbol-interface', Endpoint: 'globe',
    Page: 'window', Navigation: 'compass', Flow: 'type-hierarchy-sub', Messages: 'comment', Scenario: 'beaker', Migration: 'history'
};

const LAYER_ICONS: Record<string, string> = {
    domain: 'database', behavior: 'zap', application: 'gear', interface: 'radio-tower', experience: 'window', cross: 'layers'
};

export function iconOf(kind: string): string {
    return ICONS[kind] ?? 'symbol-misc';
}

const STATE_COLORS: Record<string, string> = {
    implemented: 'charts.green', partial: 'charts.yellow', unimplemented: 'disabledForeground'
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

/** The properties of an element, without its flags and the type of a field or parameter (its description has it). */
export function properties(index: GraphIndex, qn: string): [string, unknown][] {
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
        const tasks = snapshot.tasks.filter(t => t.qn === qn && t.status !== 'done');
        nodes.push({
            id: 'implementation', label: IMPLEMENTATION_LABELS[implementation.state], icon: 'circle-filled', color: STATE_COLORS[implementation.state],
            description: [implementation.tasks && `${implementation.tasks} open task${implementation.tasks > 1 ? 's' : ''}`, implementation.outstanding && 'changed since the last generation'].filter(Boolean).join(' · '),
            children: [
                ...code.map((c, i) => ({
                    id: `code/${i}`, label: `${c.file}:${c.start}-${c.end}`, description: c.status === 'current' ? undefined : c.status, file: c.file, tooltip: c.text,
                    run: { type: 'code', path: c.file, start: c.start, end: c.end } as Run
                })),
                ...tasks.flatMap(t => t.missing.map((m, i) => ({ id: `task/${t.target}/${i}`, label: m, description: `task · ${t.target}`, icon: 'circle-large-outline', run: { type: 'action', action: { type: 'select', qn } } as Run })))
            ],
            expanded: true
        });
    }
    // a click opens the source and keeps the inspected element; the inline button inspects the target
    const link = (id: string, target: string, description?: string, label?: string): PanelNode =>
        ({ ...element(id, index, target, description, label), run: { type: 'source', qn: target }, inspect: target });
    if (node.kind === 'Action') {
        const summary = actionSummary(index, qn);
        const rows: [string, string | undefined][] = [
            ['Input', summary.inputs.join('; ')], ['Requires', summary.requires.join('; ')], ['Changes', summary.changes.join('; ') || 'nothing in the model'],
            ['Errors', summary.errors.join(', ')], ['Consistency', summary.consistency]
        ];
        nodes.push(...group('does', 'What it does', 'info', [
            ...summary.on ? [link('does/on', summary.on, 'on')] : [],
            ...rows.filter(([, value]) => value).map(([label, value]) => ({ id: `does/${label}`, label, description: value, tooltip: value }))
        ], { counted: false }));
        const simulator = new Simulator(index.graph);
        nodes.push(...group('who', 'Who may trigger it', 'person', simulator.actors(qn).filter(a => a.verdict !== 'no').map(a => link(`who/${a.actor}`, a.actor, VERDICTS[a.verdict]))));
        nodes.push(...group('risks', 'Invariants at risk', 'warning', simulator.risks(qn).map(r => link(`risk/${r.invariant}`, r.invariant, `reads ${r.fields.join(', ')}`))));
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
        nodes.push(...group('can', 'What they can do', 'key', [...groups].flatMap(([label, entries]) => group(`can/${label}`, label, 'folder',
            entries.filter(e => e.verdict !== 'no').sort((a, b) => Number(a.verdict === 'depends') - Number(b.verdict === 'depends')).map(e => ability(`can/${label}`, e))))));
    }
    if (node.kind === 'Entity') {
        nodes.push(...group('actions', 'Actions', iconOf('Action'), entityActions(index, qn).map(a => link(`action/${a.qn}`, a.qn, [a.creates ? 'creates' : '', ...a.transitions].filter(Boolean).join(', ')))));
    }
    if (node.kind === 'Machine') {
        const simulator = new Simulator(index.graph);
        const field = index.nodes.get(String(node.data.field));
        const states = field ? index.children(String((field.data.type as { decl?: string }).decl)).map(l => l.qn.slice(l.qn.lastIndexOf('.') + 1)) : [];
        nodes.push(...group('states', 'Reachable states', iconOf('EnumLiteral'), states.map(s => {
            const reach = simulator.reach(qn, s);
            return { id: `state/${s}`, label: s, description: reach ? (reach.path.length ? `via ${reach.path.map(p => p.trigger).join(', ')}` : 'initial') : 'unreachable' };
        })));
    }
    nodes.push(...group('props', 'Properties', 'symbol-property', properties(index, qn).map(([key, value]) => {
        const lines = Array.isArray(value) ? value.map(String) : [String(value)];
        if (!Array.isArray(value) || key === 'modifiers') return { id: `prop/${key}`, label: key, description: lines.join(' '), tooltip: lines.join(' ') };
        return { id: `prop/${key}`, label: key, description: String(lines.length), expanded: true, children: lines.map((text, i) => ({ id: `prop/${key}/${i}`, label: text, tooltip: text })) };
    }), { expanded: false, counted: false }));
    for (const [kind, members] of Map.groupBy(index.children(qn), c => c.kind)) {
        const rows = members.map(c => ({ ...link(`member/${c.qn}`, c.qn, undefined, memberText(c, index)), description: undefined }));
        nodes.push(...group(`members/${kind}`, plural(kind), iconOf(kind), rows, { expanded: kind !== 'Policy' && kind !== 'Invariant' }));
    }
    for (const [direction, title, icon] of [['usedBy', 'Used by', 'call-incoming'], ['uses', 'Uses', 'call-outgoing']] as const) {
        const byLayer = relations(index, qn, direction);
        nodes.push(...group(direction, title, icon, [...byLayer].flatMap(([layer, items]) => group(`${direction}/${layer}`, LAYER_LABELS[layer], LAYER_ICONS[layer],
            items.map(r => link(`${direction}/${layer}/${r.qn}`, r.qn, `${kindLabel(r.kind)}${r.via.length ? ` via ${r.via.join(', ')}` : ''}`)))), { expanded: direction === 'usedBy' }));
    }
    return nodes;
}

function sessionName(state: PanelState, id: string): string {
    const session = state.sessions.find(s => s.id === id);
    return session ? session.label ?? session.name : 'ended session';
}

/** The changed elements of a diff, each selecting its element. */
function changeNodes(prefix: string, index: GraphIndex, changes: (ElementChange | undefined)[], details: (c: ElementChange) => string | undefined): PanelNode[] {
    return changes.filter((c): c is ElementChange => !!c).map(c => ({
        ...element(`${prefix}/${c.status}/${c.qn}`, index, c.qn, details(c)),
        status: c.status
    }));
}

function changesTree(state: PanelState, index: GraphIndex): PanelNode[] {
    const live = state.live;
    const changes = new Map((live?.diff.changes ?? []).map(c => [c.qn, c]));
    const files = live?.files ?? [];
    return [
        ...files.map((f): PanelNode => ({
            id: `file/${f.path}`, label: f.path, file: f.path, status: f.status,
            description: `${f.sessions.length ? f.sessions.map(id => sessionName(state, id)).join(', ') : 'written to disk'} · ${new Date(f.at).toLocaleTimeString()}`,
            tooltip: `${f.path}\n${new Date(f.at).toLocaleString()}`,
            run: { type: 'liveDiff', path: f.path },
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
