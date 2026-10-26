import type { Access, Graph, GraphNode, TypeData } from '@appling/model';
import { relevance } from '@appling/model/relevance';
import { Simulator } from '@appling/model/simulator';

/** The layers the tree starts from: each tab grows the model from the declarations of its kinds, module by module. */
export type Lens = 'domain' | 'behavior' | 'application' | 'interfaces' | 'access';

export const LENSES: Record<Lens, { label: string, kinds: string[] }> = {
    domain: { label: 'Domain', kinds: ['Entity', 'ValueType', 'Enum'] },
    behavior: { label: 'Behavior', kinds: ['Action', 'Event', 'Machine', 'Job'] },
    application: { label: 'Application', kinds: ['Query', 'Projection', 'External', 'UseCase'] },
    interfaces: { label: 'Interfaces', kinds: ['Interface', 'Page', 'Navigation', 'Flow', 'Messages'] },
    access: { label: 'Access', kinds: ['Role', 'Actor', 'Tenant'] }
};

/** What the canvas shows, kept in `.appling/view.json` outside the model. */
export interface ViewSettings {
    lens: Lens;
    /** Link entities, such as join records. */
    linkEntities: boolean;
}

export const DEFAULT_VIEW: ViewSettings = { lens: 'domain', linkEntities: false };

/**
 * One node of the dependency tree. The seed holds the modules, a module the declarations of the lens, a declaration
 * the declarations that use it, grouped by kind as soon as there is more than one kind.
 */
export interface TreeNode {
    /** The path from the seed, unique in the tree. */
    id: string;
    type: 'seed' | 'module' | 'group' | 'element';
    /** The module or the element. */
    qn?: string;
    /** The element kind, or the kind of a group's elements. */
    kind?: string;
    layer?: string;
    label: string;
    /** For an element: what it is about, such as `on Order · draft → placed`. For a module: what it holds. */
    fact: string;
    /** How many nodes unfolding shows: dependents for an element, members for a module or group. */
    count: number;
    /** From 0 to 1, how much it matters to the application (`relevance` in `@appling/model`); a group takes its most relevant element's. */
    relevance: number;
    /** The element already appears on the path below, so it does not unfold again. */
    cycle?: boolean;
    /** Present when unfolded. */
    children?: TreeNode[];
}

/** Grows the tree of a lens: the seed and every node whose id is in `unfolded` show their children. */
export function growTree(index: GraphIndex, settings: ViewSettings, unfolded: Set<string>, name = 'model'): TreeNode {
    const shown = (n: GraphNode) => settings.linkEntities || !n.props.link;
    const roots = index.graph.nodes.filter(n => LENSES[settings.lens].kinds.includes(n.kind) && index.declaration(n.qn) === n.qn && shown(n));
    const modules = [...new Set(roots.map(n => n.module))];
    const dependents = new Map<string, GraphNode[]>();
    const dependentsOf = (qn: string) => {
        if (!dependents.has(qn)) {
            const used = [...relations(index, qn, 'usedBy').values()].flat().map(r => index.nodes.get(r.qn)!).filter(n => n.kind !== 'Module' && shown(n));
            dependents.set(qn, used);
        }
        return dependents.get(qn)!;
    };
    const element = (node: GraphNode, parent: string, module: string, path: string[]): TreeNode => {
        const id = `${parent}/${node.qn}`;
        const cycle = path.includes(node.qn);
        const used = cycle ? [] : dependentsOf(node.qn);
        const label = node.module === module ? localName(node.qn, index) : node.qn;
        const tree: TreeNode = { id, type: 'element', qn: node.qn, kind: node.kind, layer: node.layer, label, fact: factOf(index, node), count: used.length, relevance: index.relevanceOf(node.qn), cycle };
        if (unfolded.has(id) && used.length) tree.children = grouped(used, id, node.module, [...path, node.qn]);
        return tree;
    };
    /** Elements directly when they are of one kind, else one group per kind; the most relevant first. */
    const grouped = (nodes: GraphNode[], parent: string, module: string, path: string[]): TreeNode[] => {
        const sorted = [...nodes].sort((a, b) => index.relevanceOf(b.qn) - index.relevanceOf(a.qn) || rank(a.kind) - rank(b.kind));
        const byKind = Map.groupBy(sorted, n => n.kind);
        if (byKind.size === 1) return sorted.map(n => element(n, parent, module, path));
        return [...byKind].map(([kind, members]) => {
            const id = `${parent}/#${kind}`;
            const group: TreeNode = { id, type: 'group', kind, layer: members[0].layer, label: plural(kind), fact: '', count: members.length, relevance: index.relevanceOf(members[0].qn) };
            if (unfolded.has(id)) group.children = members.map(n => element(n, id, module, path));
            return group;
        });
    };
    const seed: TreeNode = { id: '~', type: 'seed', label: name, fact: `${modules.length} module${modules.length === 1 ? '' : 's'}`, count: modules.length, relevance: 1 };
    if (unfolded.has(seed.id)) {
        seed.children = modules.sort((a, b) => index.relevanceOf(b) - index.relevanceOf(a)).map(module => {
            const members = roots.filter(n => n.module === module);
            const id = `~/${module}`;
            const kinds = [...Map.groupBy(members, n => n.kind)].sort(([a], [b]) => rank(a) - rank(b)).map(([kind, list]) => `${list.length} ${list.length === 1 ? kindLabel(kind) : plural(kind).toLowerCase()}`);
            const tree: TreeNode = { id, type: 'module', qn: module, label: module, fact: kinds.join(' · '), count: members.length, relevance: index.relevanceOf(module) };
            if (unfolded.has(id)) tree.children = grouped(members, id, module, []);
            return tree;
        });
    }
    return seed;
}

/** The node ids to unfold so that the declaration of an element shows on the first level of its module, if the lens has it. */
export function revealPath(index: GraphIndex, settings: ViewSettings, qn: string): string[] {
    const node = index.nodes.get(index.declaration(qn));
    if (node?.kind === 'Module') return ['~', `~/${node.qn}`];
    if (!node || !LENSES[settings.lens].kinds.includes(node.kind)) return [];
    return ['~', `~/${node.module}`, `~/${node.module}/#${node.kind}`];
}

/** Groups come in the order of the layers, and within a layer the kind a developer looks for first. */
const KIND_ORDER = [
    'Role', 'Actor', 'Tenant', 'Entity', 'ValueType', 'Enum', 'Action', 'Event', 'Machine', 'Job',
    'UseCase', 'Query', 'Projection', 'External', 'Interface', 'Page', 'Navigation', 'Flow', 'Messages'
];

function rank(kind: string): number {
    const at = KIND_ORDER.indexOf(kind);
    return at < 0 ? KIND_ORDER.length : at;
}

const PLURALS: Record<string, string> = { Query: 'Queries', Entity: 'Entities', UseCase: 'Use cases', ValueType: 'Value types', Messages: 'Messages' };

function plural(kind: string): string {
    if (PLURALS[kind]) return PLURALS[kind];
    const label = kindLabel(kind);
    return `${label[0].toUpperCase()}${label.slice(1)}s`;
}

/** The one or two facts a developer needs first to place a declaration, after its name and kind. */
export function factOf(index: GraphIndex, node: GraphNode): string {
    const members = (kind: string) => index.children(node.qn).filter(c => c.kind === kind).length;
    const name = (qn: unknown) => typeof qn === 'string' ? shortName(qn, index) : '';
    const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
    const facts: Record<string, () => string[]> = {
        Entity: () => [count(members('Field'), 'field'), `${count(index.graph.nodes.filter(n => n.kind === 'Action' && n.data.entity === node.qn).length, 'action')} on it`],
        ValueType: () => [count(members('Field'), 'field')],
        Enum: () => [count(members('EnumLiteral'), 'value')],
        Event: () => [count(members('Field'), 'field')],
        Action: () => [node.data.entity ? `on ${name(node.data.entity)}` : '', ...transitionsOf(index, node.qn).map(t => `${(t.props.from as string[]).join(', ')} → ${t.props.to}`)],
        Machine: () => {
            const field = index.nodes.get(String(node.data.field));
            const states = field ? index.children(String((field.data.type as TypeData | undefined)?.decl ?? '')).length : 0;
            return [`on ${name(node.data.field)}`, count(states, 'state')];
        },
        Job: () => [node.props.schedule ? `every ${node.props.schedule}` : '', node.data.action ? `runs ${name(node.data.action)}` : ''],
        Query: () => [`from ${name(node.data.entity)}`],
        Projection: () => [`from ${name(node.data.source)}`],
        External: () => [count(members('ExternalOperation'), 'operation')],
        UseCase: () => [count(((node.props.steps as string[] | undefined) ?? []).length, 'step')],
        Interface: () => [String(node.props.protocol ?? ''), count(members('Endpoint'), 'endpoint')],
        Page: () => [String(node.props.route ?? '')],
        Navigation: () => [count(((node.props.items as string[] | undefined) ?? []).length, 'item')],
        Flow: () => [count(((node.data.pages as string[] | undefined) ?? []).length, 'page')],
        Messages: () => [count(((node.props.entries as string[] | undefined) ?? []).length, 'key')],
        Actor: () => [String(node.props.kind ?? ''), ...((node.data.roles as string[] | undefined) ?? []).map(r => `role ${name(r)}`)],
        Tenant: () => [`on ${name(node.data.entity)}`]
    };
    return (facts[node.kind]?.() ?? []).filter(Boolean).join(' · ');
}

export interface Relation {
    qn: string;
    kind: string;
    /** The members the reference runs through: of the other declaration for `usedBy`, of the element itself for `uses`. */
    via: string[];
}

export interface EntityAction {
    qn: string;
    /** The machine transitions the action drives, such as `draft, placed -> cancelled`. */
    transitions: string[];
    /** Declared elsewhere and creates records of the entity. */
    creates: boolean;
}

export interface ActionSummary {
    on?: string;
    inputs: string[];
    requires: string[];
    /** Its own effects, then each transition it drives with that transition's effects. */
    changes: string[];
    errors: string[];
    consistency?: string;
}

export const LAYERS = ['domain', 'behavior', 'application', 'interface', 'experience', 'cross'];

export const LAYER_LABELS: Record<string, string> = {
    domain: 'Domain', behavior: 'Behavior', application: 'Application', interface: 'Interfaces', experience: 'Experience', cross: 'Cross cutting'
};

const KIND_LABELS: Record<string, string> = { ErrorDecl: 'error', UseCase: 'usecase', ValueType: 'value' };

export class GraphIndex {
    readonly nodes: Map<string, GraphNode>;
    private readonly relevance: Map<string, number>;
    private readonly childrenOf = new Map<string, GraphNode[]>();
    private readonly parentOf = new Map<string, string>();

    constructor(readonly graph: Graph) {
        this.nodes = new Map(graph.nodes.map(n => [n.qn, n]));
        this.relevance = relevance(graph);
        for (const edge of graph.edges.filter(e => e.kind === 'contains')) {
            this.childrenOf.set(edge.from, [...(this.childrenOf.get(edge.from) ?? []), this.nodes.get(edge.to)!]);
            this.parentOf.set(edge.to, edge.from);
        }
    }

    /** The relevance of the declaration an element belongs to, or of a module. */
    relevanceOf(qn: string): number {
        return this.relevance.get(this.declaration(qn)) ?? 0;
    }

    children(qn: string): GraphNode[] {
        return this.childrenOf.get(qn) ?? [];
    }

    parent(qn: string): string | undefined {
        return this.parentOf.get(qn);
    }

    /** The qualified name itself and its ancestors, innermost first. */
    lineage(qn: string): string[] {
        const result: string[] = [];
        for (let current: string | undefined = qn; current; current = this.parent(current)) result.push(current);
        return result;
    }

    /** The top level declaration an element belongs to; a module stands for itself. */
    declaration(qn: string): string {
        return this.lineage(qn).find(q => this.nodes.get(this.parent(q) ?? '')?.kind === 'Module') ?? qn;
    }
}

export type ViewKind = 'entities' | 'machine' | 'action' | 'usecase' | 'event';

/** The element kinds each view is drawn for. */
export const VIEW_KINDS: Record<ViewKind, string[]> = {
    entities: ['Entity', 'Module'], machine: ['Machine'], action: ['Action'], usecase: ['UseCase'], event: ['Event']
};

/** The view that draws an element of this kind, if any. */
export function viewFor(kind: string): ViewKind | undefined {
    return (Object.keys(VIEW_KINDS) as ViewKind[]).find(view => VIEW_KINDS[view].includes(kind));
}

export interface CardRow {
    text: string;
    /** The element a click selects. */
    qn?: string;
    note?: string;
}

export interface CardSection {
    title?: string;
    rows: CardRow[];
}

/** One state, action, use case or event as a card of options and facts instead of boxes and arrows. */
export interface Card {
    id: string;
    qn: string;
    title: string;
    tag?: string;
    sections: CardSection[];
}

interface CallData {
    target: string;
}

interface StepData {
    $type: string;
    call?: CallData;
    event?: string;
}

const CARDS: Record<Exclude<ViewKind, 'entities'>, (index: GraphIndex, qn: string) => Card[]> = {
    machine: machineCards, action: actionCards, usecase: useCaseCards, event: eventCards
};

/** The cards of every focused element, in focus order. */
export function cardView(index: GraphIndex, view: Exclude<ViewKind, 'entities'>, focus: string[]): Card[] {
    return focus.filter(qn => index.nodes.has(qn)).flatMap(qn => CARDS[view](index, qn));
}

/**
 * One card per state of the machine's field type with what can be done there: each action or event that leaves the
 * state, with the states it leads to, its guard and the jobs that run it.
 */
function machineCards(index: GraphIndex, qn: string): Card[] {
    const field = index.nodes.get(String(index.nodes.get(qn)!.data.field));
    const states = String((field?.data.type as TypeData | undefined)?.decl ?? '');
    const transitions = index.children(qn).filter(c => c.kind === 'Transition');
    const jobs = index.graph.nodes.filter(n => n.kind === 'Job');
    return index.children(states).filter(c => c.kind === 'EnumLiteral').map(literal => {
        const name = localName(literal.qn, index);
        const options = new Map<string, CardRow & { to: string[] }>();
        for (const transition of transitions.filter(t => (t.props.from as string[]).includes(name))) {
            const { action, event } = transition.data as { action?: string, event?: string };
            const by = action ? shortName(action, index) : `on ${shortName(event ?? '', index)}`;
            const guard = transition.props.guard as string | undefined;
            const key = `${by}|${guard ?? ''}`;
            const running = jobs.filter(j => action && j.data.action === action && runsIn(j, literal.qn, states)).map(j => `job ${shortName(j.qn, index)}`);
            const option = options.get(key) ?? { text: '', qn: action ?? event, to: [], note: [guard && `when ${guard}`, ...running].filter(Boolean).join(' · ') || undefined };
            option.to.push(String(transition.props.to));
            option.text = `${by} → ${option.to.join(', ')}`;
            options.set(key, option);
        }
        const rows = [...options.values()].map(({ text, qn, note }) => ({ text, qn, note }));
        const tag = field?.props.default === name ? 'initial' : rows.length ? undefined : 'final';
        return { id: literal.qn, qn: literal.qn, title: name, tag, sections: rows.length ? [{ rows }] : [] };
    });
}

/** Whether a job may pick records in this state: its filter names the state, or names no state at all. */
function runsIn(job: GraphNode, state: string, states: string): boolean {
    const filter = JSON.stringify(job.data.filter ?? null);
    return filter.includes(`"target":"${state}"`) || !filter.includes(`"target":"${states}.`);
}

/** What an action allows and does: the states it moves between, who may run it, its inputs, preconditions, changes, events, errors and users. */
function actionCards(index: GraphIndex, qn: string): Card[] {
    const summary = actionSummary(index, qn);
    const transitions = transitionsOf(index, qn);
    const effects = [...index.children(qn), ...transitions.flatMap(t => index.children(t.qn))].filter(m => m.kind.endsWith('Effect'));
    const sections: CardSection[] = [
        { title: 'States', rows: transitions.map(t => ({ text: `${(t.props.from as string[]).join(', ')} → ${t.props.to}`, qn: index.parent(t.qn), note: t.props.guard ? `when ${t.props.guard}` : undefined })) },
        { title: 'Who', rows: new Simulator(index.graph).actors(qn).map(a => ({ text: `${shortName(a.actor, index)}: ${a.verdict}`, qn: a.actor })) },
        { title: 'Inputs', rows: summary.inputs.map(text => ({ text })) },
        { title: 'Requires', rows: summary.requires.map(text => ({ text })) },
        { title: 'Changes', rows: effects.map(e => ({ text: effectText(e), qn: e.kind === 'EmitEffect' ? String(e.data.event) : undefined })) },
        { title: 'Errors', rows: index.children(qn).filter(m => m.kind === 'ErrorDecl').map(e => ({ text: localName(e.qn, index) })) },
        { title: 'Used by', rows: usedBy(index, qn) }
    ];
    return [{ id: qn, qn, title: shortName(qn, index), tag: summary.on ? `on ${shortName(summary.on, index)}` : 'action', sections: sections.filter(s => s.rows.length) }];
}

/** The steps of a use case in order as written, each selecting what it calls or awaits. */
function useCaseCards(index: GraphIndex, qn: string): Card[] {
    const useCase = index.nodes.get(qn)!;
    const texts = (useCase.props.steps as string[] | undefined) ?? [];
    const steps = ((useCase.data.steps as StepData[] | undefined) ?? []).map((step, i) => ({ text: `${i + 1}. ${texts[i] ?? ''}`, qn: step.$type === 'AwaitStep' ? step.event : step.call?.target }));
    const sections: CardSection[] = [
        { title: 'Inputs', rows: index.children(qn).filter(m => m.kind === 'Param').map(m => ({ text: memberText(m, index) })) },
        { title: 'Steps', rows: steps },
        { title: 'Used by', rows: usedBy(index, qn) }
    ];
    return [{ id: qn, qn, title: shortName(qn, index), tag: 'usecase', sections: sections.filter(s => s.rows.length) }];
}

/** An event with its fields, what emits it, and the transitions and use cases it drives. */
function eventCards(index: GraphIndex, qn: string): Card[] {
    const emitters = index.graph.nodes.filter(n => n.kind === 'EmitEffect' && n.data.event === qn).map(emit => {
        const owner = index.nodes.get(index.parent(emit.qn)!)!;
        return owner.kind === 'Transition' ? String(owner.data.action ?? index.parent(owner.qn)) : owner.qn;
    });
    const awaiting = index.graph.nodes.filter(n => n.kind === 'UseCase' && ((n.data.steps as StepData[] | undefined) ?? []).some(s => s.$type === 'AwaitStep' && s.event === qn));
    const sections: CardSection[] = [
        { title: 'Fields', rows: index.children(qn).filter(m => m.kind === 'Field').map(m => ({ text: memberText(m, index) })) },
        { title: 'Emitted by', rows: [...new Set(emitters)].map(e => ({ text: shortName(e, index), qn: e })) },
        {
            title: 'Triggers',
            rows: index.graph.nodes.filter(n => n.kind === 'Transition' && n.data.event === qn)
                .map(t => ({ text: `${localName(index.parent(t.qn)!, index)}: ${(t.props.from as string[]).join(', ')} → ${t.props.to}`, qn: index.parent(t.qn) }))
        },
        { title: 'Resumes', rows: awaiting.map(u => ({ text: shortName(u.qn, index), qn: u.qn })) }
    ];
    return [{ id: qn, qn, title: shortName(qn, index), tag: 'event', sections: sections.filter(s => s.rows.length) }];
}

/** The declarations that refer to an element, except the machines whose transitions it drives. */
function usedBy(index: GraphIndex, qn: string): CardRow[] {
    return [...relations(index, qn, 'usedBy').values()].flat().filter(r => r.kind !== 'Machine')
        .map(r => ({ text: shortName(r.qn, index), qn: r.qn, note: kindLabel(r.kind) }));
}

/** A qualified name without its module, such as `Payments.Charge` for `sales.Payments.Charge`. */
function shortName(qn: string, index: GraphIndex): string {
    const module = index.nodes.get(qn)?.module;
    return module && qn.startsWith(`${module}.`) ? qn.slice(module.length + 1) : qn;
}

/** Elements of the chosen layers whose qualified name or kind contains every word; without words, the top level declarations. */
export function search(index: GraphIndex, query: string, layers: string[]): GraphNode[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return index.graph.nodes.filter(n => layers.includes(n.layer) && (words.length
        ? words.every(w => n.qn.toLowerCase().includes(w) || kindLabel(n.kind).includes(w))
        : index.declaration(n.qn) === n.qn));
}

/**
 * The declarations an element and its members refer to (`uses`) or are referred by (`usedBy`), each lifted to
 * its top level declaration and grouped by layer.
 */
export function relations(index: GraphIndex, qn: string, direction: 'uses' | 'usedBy'): Map<string, Relation[]> {
    const inside = (q: string) => q === qn || q.startsWith(`${qn}.`);
    const found = new Map<string, Relation>();
    for (const edge of index.graph.edges.filter(e => e.kind !== 'contains')) {
        const [own, other] = direction === 'uses' ? [edge.from, edge.to] : [edge.to, edge.from];
        if (!inside(own) || inside(other)) continue;
        const declaration = index.nodes.get(index.declaration(other))!;
        const relation = found.get(declaration.qn) ?? { qn: declaration.qn, kind: declaration.kind, via: [] };
        const [member, base] = direction === 'uses' ? [own, qn] : [other, declaration.qn];
        const via = member.slice(base.length + 1);
        if (via && !relation.via.includes(via)) relation.via.push(via);
        found.set(declaration.qn, relation);
    }
    const byLayer = new Map<string, Relation[]>();
    for (const relation of found.values()) {
        const layer = index.nodes.get(relation.qn)!.layer;
        byLayer.set(layer, [...(byLayer.get(layer) ?? []), relation]);
    }
    return new Map(LAYERS.filter(l => byLayer.has(l)).map(l => [l, byLayer.get(l)!]));
}

/** The actions declared on an entity with the transitions they drive, then the declarations elsewhere that create its records. */
export function entityActions(index: GraphIndex, qn: string): EntityAction[] {
    const on = index.graph.nodes.filter(n => n.kind === 'Action' && n.data.entity === qn)
        .map(a => ({ qn: a.qn, transitions: transitionsOf(index, a.qn).map(transitionText), creates: false }));
    const creators = index.graph.nodes.filter(n => n.kind === 'CreateEffect' && n.data.entity === qn).map(e => index.declaration(e.qn));
    return [...on, ...[...new Set(creators)].filter(c => !on.some(a => a.qn === c)).map(c => ({ qn: c, transitions: [], creates: true }))];
}

/** What an action does, in the words of the model. */
export function actionSummary(index: GraphIndex, qn: string): ActionSummary {
    const action = index.nodes.get(qn)!;
    const members = index.children(qn);
    const changes = members.filter(m => m.kind.endsWith('Effect')).map(effectText);
    for (const transition of transitionsOf(index, qn)) {
        changes.push(`${localName(index.parent(transition.qn)!, index)}: ${transitionText(transition)}`);
        changes.push(...index.children(transition.qn).filter(m => m.kind.endsWith('Effect')).map(e => `  ${effectText(e)}`));
    }
    return {
        on: action.data.entity as string | undefined,
        inputs: members.filter(m => m.kind === 'Param').map(m => memberText(m, index)),
        requires: (action.props.preconditions as string[] | undefined) ?? [],
        changes,
        errors: members.filter(m => m.kind === 'ErrorDecl').map(m => localName(m.qn, index)),
        consistency: action.props.consistency as string | undefined
    };
}

function transitionsOf(index: GraphIndex, action: string): GraphNode[] {
    return index.graph.nodes.filter(n => n.kind === 'Transition' && n.data.action === action);
}

function transitionText(transition: GraphNode): string {
    return `${(transition.props.from as string[]).join(', ')} -> ${transition.props.to}`;
}

/** An effect as one line, such as `set placed_at = now` or `emit OrderPlaced { order = this }`. */
function effectText(effect: GraphNode): string {
    const key = effect.qn.slice(effect.qn.lastIndexOf('effect[') + 'effect['.length, -1);
    const assignments = effect.props.assignments as string[] | undefined;
    return `${key}${effect.props.value ? ` = ${effect.props.value}` : ''}${assignments ? ` { ${assignments.join(', ')} }` : ''}`;
}

export interface Ability extends Access {
    /** For a page: the actions it offers, with their own verdicts. */
    offers?: Access[];
}

const ABILITY_GROUPS: [string, string][] = [['Action', 'Actions'], ['Page', 'Pages'], ['UseCase', 'Use cases'], ['Query', 'Queries'], ['Entity', 'Data']];

/** What an actor may do, grouped as actions, pages with the actions they offer, use cases, queries and entity data. */
export function abilities(index: GraphIndex, access: Access[]): Map<string, Ability[]> {
    const byTarget = new Map(access.filter(a => !a.operation).map(a => [a.target, a]));
    const groups = new Map<string, Ability[]>(ABILITY_GROUPS.map(([, label]) => [label, []]));
    for (const entry of access) {
        const node = index.nodes.get(entry.target)!;
        const group = groups.get(ABILITY_GROUPS.find(([kind]) => kind === node.kind)![1])!;
        if (node.kind !== 'Page') {
            group.push(entry);
            continue;
        }
        const components = (node.data.components ?? []) as { actions?: string[], submits?: string }[];
        const offered = [...new Set(components.flatMap(c => [...(c.actions ?? []), ...(c.submits ? [c.submits] : [])]))];
        group.push({ ...entry, offers: offered.map(a => byTarget.get(a)).filter(a => a !== undefined) });
    }
    return new Map([...groups].filter(([, entries]) => entries.length));
}

/** A policy as one line, such as `Order policy[read]: actor.is(crm.Clerk) || customer == actor.account`. */
export function policyText(index: GraphIndex, qn: string): string {
    const owner = index.parent(qn)!;
    const key = qn.slice(owner.length + 1);
    return `${localName(owner, index)} ${key === 'policy[]' ? 'policy' : key}: ${index.nodes.get(qn)!.props.condition}`;
}

/** The innermost element whose source contains the offset. */
export function elementAt(locations: Record<string, { uri: string, start: number, end: number }>, uri: string, offset: number): string | undefined {
    let best: string | undefined;
    let size = Infinity;
    for (const [qn, l] of Object.entries(locations)) {
        if (l.uri === uri && l.start <= offset && offset <= l.end && l.end - l.start < size) {
            best = qn;
            size = l.end - l.start;
        }
    }
    return best;
}

/** A kind as people read it: `UseCase` as `usecase`, `EnumLiteral` as `enum literal`. */
export function kindLabel(kind: string): string {
    return KIND_LABELS[kind] ?? kind.replace(/(?<=.)([A-Z])/g, ' $1').toLowerCase();
}

/** A member as one line, such as `status: OrderStatus state`. */
export function memberText(node: GraphNode, index: GraphIndex): string {
    const type = typeof node.props.type === 'string' ? `: ${node.props.type}` : '';
    const modifiers = Array.isArray(node.props.modifiers) ? ` ${node.props.modifiers.join(' ')}` : '';
    return `${localName(node.qn, index)}${type}${modifiers}`;
}

function localName(qn: string, index: GraphIndex): string {
    return qn.slice((index.parent(qn)?.length ?? -1) + 1);
}
