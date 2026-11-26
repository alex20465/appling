import type { Access, Graph, GraphNode, TypeData } from '@appling/model';
import { annotationOf } from '@appling/lang/layers';
import { relevance, RELEVANCE_LEVELS, type RelevanceLevel } from '@appling/model/relevance';
import { Simulator } from '@appling/model/simulator';
import { rollupState, type ImplementationState } from '@appling/model/implementation';

/** The levels of the pyramid, L1 first: each answers one question and is one band of the canvas. */
export type Lens = 'domain' | 'behavior' | 'application' | 'interfaces' | 'access';

export const LENSES: Record<Lens, { label: string, question: string, kinds: string[] }> = {
    domain: { label: 'Domain', question: 'What exists?', kinds: ['Entity', 'ValueType', 'Enum'] },
    behavior: { label: 'Behavior', question: 'What can happen?', kinds: ['Action', 'Event', 'Machine', 'Job'] },
    application: { label: 'Application', question: 'How is it exposed?', kinds: ['Query', 'Projection', 'External', 'UseCase'] },
    interfaces: { label: 'Interfaces', question: 'What is exposed and where?', kinds: ['Interface', 'Page', 'Navigation', 'Flow', 'Messages'] },
    access: { label: 'Access', question: 'Who can do what?', kinds: ['Role', 'Actor', 'Tenant'] }
};

/** The level of a kind, 1 to 5; none for kinds outside the pyramid, such as scenarios and migrations. */
export function levelOf(kind: string): number | undefined {
    const at = Object.values(LENSES).findIndex(lens => lens.kinds.includes(kind));
    return at < 0 ? undefined : at + 1;
}

/** What the canvas shows, kept in `.appling/view.json` outside the model. */
export interface ViewSettings {
    /** The entry level: the band whose declarations the pyramid starts from. */
    lens: Lens;
    /** Link entities, such as join records. */
    linkEntities: boolean;
    /**
     * The Lucide icon of nodes, by what they are: the qualified name of a module or a declaration, a kind (every
     * declaration of it without an icon of its own) or `~` for the seed. Set by the `set_icons` tool.
     */
    icons?: Record<string, string>;
    /** The view of the model the inspector shows; the level canvas when unset. */
    view?: ModelView;
    /** The least relevance level the views draw: `core` alone, or down to this level; everything when unset. */
    relevance?: RelevanceLevel;
}

/** The views of the model: the level canvas, the use case diagram, the state diagrams and the screens. */
export type ModelView = 'levels' | 'usecases' | 'states' | 'screens';

export const DEFAULT_VIEW: ViewSettings = { lens: 'domain', linkEntities: false, relevance: 'core' };

/** Whether a declaration is relevant enough for the views: its score reaches the level they draw down to. */
export function relevantFor(index: GraphIndex, qn: string, level?: RelevanceLevel): boolean {
    return !level || index.relevanceOf(qn) >= RELEVANCE_LEVELS[level][0];
}

/**
 * One node of the pyramid. The seed holds the modules, a module its declarations of the entry level, a declaration
 * the declarations of higher levels that rest on it (`up`) and those of lower levels it rests on (`down`).
 */
export interface TreeNode {
    /** The path from the seed, unique in the tree. */
    id: string;
    type: 'seed' | 'module' | 'element';
    /** The module or the element. */
    qn?: string;
    kind?: string;
    layer?: string;
    /** The level of an element, 1 to 5: the band it stands in. */
    level?: number;
    /** Where an element stands from the node it unfolded from; none on the entry level. */
    side?: Side;
    label: string;
    /** For an element: what it is about, such as `on Order · draft → placed`. For a module: what it holds. */
    fact: string;
    /** How many nodes unfolding shows: both sides for an element, members for a module. */
    count: number;
    /** How many declarations unfolding an element upwards and downwards shows. */
    up?: number;
    down?: number;
    /** From 0 to 1, how much it matters to the application (`relevance` in `@appling/model`). */
    relevance: number;
    /** The annotation of an element, the work its code has to do that the model does not state: its keyword and text. */
    note?: { keyword: string, text: string };
    /** The sides that are unfolded. */
    open?: Side[];
    /** What an unfolded side also leads to but is drawn elsewhere already: the canvas joins the two instead of drawing it again. */
    links?: string[];
    /** Present when unfolded. */
    children?: TreeNode[];
}

export type Side = 'up' | 'down';

/** The id in the unfolded set that opens one side of an element. */
export function sideId(id: string, side: Side): string {
    return `${id}^${side}`;
}

const pyramids = new WeakMap<GraphIndex, Map<string, Set<string>>>();

/**
 * Which declarations of the pyramid belong together, in both directions: every reference and name between two of
 * them, and for a role, actor or tenant the pages and interfaces that expose what its policies name.
 */
function links(index: GraphIndex): Map<string, Set<string>> {
    if (pyramids.has(index)) return pyramids.get(index)!;
    const found = new Map<string, Set<string>>();
    const level = (qn: string) => levelOf(index.nodes.get(qn)?.kind ?? '');
    const link = (a: string, b: string) => {
        if (a === b || !level(a) || !level(b)) return;
        for (const [from, to] of [[a, b], [b, a]]) found.set(from, (found.get(from) ?? new Set()).add(to));
    };
    for (const edge of index.graph.edges) if (edge.kind !== 'contains') link(index.declaration(edge.from), index.declaration(edge.to));
    const of = (qn: string) => [...found.get(qn) ?? []];
    const exposures = [...found.keys()].filter(qn => level(qn) === 4);
    for (const who of [...found.keys()].filter(qn => level(qn) === 5)) {
        // an actor may what its roles may; a query asks for what its entity allows
        const named = [who, ...of(who).filter(qn => index.nodes.get(qn)!.kind === 'Role')].flatMap(of).filter(qn => level(qn)! < 4);
        const granted = new Set([...named, ...named.flatMap(of).filter(qn => index.nodes.get(qn)!.kind === 'Query')]);
        for (const exposure of exposures) if (of(exposure).some(qn => granted.has(qn))) link(who, exposure);
    }
    pyramids.set(index, found);
    return found;
}

/**
 * The declarations one step up or down from a declaration: those of higher or lower levels it belongs together with.
 * Downwards from the top level, what a page or interface of it already exposes shows under that one only.
 */
export function linked(index: GraphIndex, qn: string, side: Side): GraphNode[] {
    const level = (q: string) => levelOf(index.nodes.get(q)!.kind)!;
    const all = links(index);
    const found = [...all.get(qn) ?? []].filter(q => side === 'up' ? level(q) > level(qn) : level(q) < level(qn));
    const exposures = level(qn) === 5 ? found.filter(q => level(q) === 4) : [];
    return found.filter(q => level(q) === 4 || !exposures.some(e => all.get(e)!.has(q))).map(q => index.nodes.get(q)!);
}

/** The declarations of its own level a declaration belongs together with: the canvas lights them up, they do not unfold. */
export function peers(index: GraphIndex, qn: string): string[] {
    const level = (q: string) => levelOf(index.nodes.get(q)?.kind ?? '');
    return [...links(index).get(index.declaration(qn)) ?? []].filter(q => level(q) === level(index.declaration(qn)));
}

/**
 * Grows the pyramid from an entry level: the seed and every module whose id is in `unfolded` show their children, an
 * element the side whose `sideId` is in it. A node on the `trail` shows only the children in `unfolded` or on the
 * trail. Away from the entry level a branch keeps its direction, so every level stands in its own band.
 */
export function growTree(index: GraphIndex, settings: ViewSettings, unfolded: Set<string>, name = 'model', trail = new Set<string>()): TreeNode {
    // what an agent shows on a trail is drawn whatever its relevance
    const shown = (n: GraphNode) => (settings.linkEntities || !n.props.link) && (trail.size > 0 || relevantFor(index, n.qn, settings.relevance));
    const roots = index.graph.nodes.filter(n => LENSES[settings.lens].kinds.includes(n.kind) && index.declaration(n.qn) === n.qn && shown(n));
    // an empty module shows on every level, such as right after an agent wrote it
    const filled = new Set(index.graph.nodes.filter(n => n.kind !== 'Module').map(n => n.module));
    const empty = index.graph.nodes.filter(n => n.kind === 'Module' && !filled.has(n.qn)).map(n => n.qn);
    const modules = [...new Set([...roots.map(n => n.module), ...empty])];
    // the nearest level first, then by kind, the most relevant first, by name among equals
    const order = (nodes: GraphNode[], side?: Side) => [...nodes].sort((a, b) => (levelOf(a.kind)! - levelOf(b.kind)!) * (side === 'down' ? -1 : 1) || rank(a.kind) - rank(b.kind) || index.relevanceOf(b.qn) - index.relevanceOf(a.qn) || a.qn.localeCompare(b.qn));
    const open = (id: string) => unfolded.has(id) || trail.has(id);
    /** What the node with this key shows of these children: all when unfolded, on a trail only those unfolded or on it. */
    const kept = <T>(key: string, items: T[], idOf: (item: T) => string) => unfolded.has(key) ? items : items.filter(item => open(idOf(item)) || SIDES.some(side => open(sideId(idOf(item), side))));
    const drawn = new Set<string>();
    /** The elements one after another, without those drawn before; all of them count as drawn before anything unfolds from the first. */
    const elements = (nodes: GraphNode[], parent: string, module: string, side?: Side): TreeNode[] => {
        const fresh = nodes.filter(node => !drawn.has(node.qn));
        for (const node of fresh) drawn.add(node.qn);
        return fresh.map(node => element(node, parent, module, side));
    };
    const element = (node: GraphNode, parent: string, module: string, side?: Side): TreeNode => {
        const id = `${parent}/${node.qn}`;
        const sides = SIDES.filter(s => !side || s === side).map(s => ({ side: s, nodes: order(linked(index, node.qn, s).filter(shown), s) }));
        const count = (s: Side) => sides.find(x => x.side === s)?.nodes.length ?? 0;
        const label = node.module === module ? localName(node.qn, index) : node.qn;
        const tree: TreeNode = { id, type: 'element', qn: node.qn, kind: node.kind, layer: node.layer, level: levelOf(node.kind), side, label, fact: factOf(index, node), count: count('up') + count('down'), up: count('up'), down: count('down'), relevance: index.relevanceOf(node.qn), note: annotationOf(node) };
        const unfolding = sides.filter(s => s.nodes.length && open(sideId(id, s.side))).map(s => ({ side: s.side, nodes: kept(sideId(id, s.side), s.nodes, n => `${id}/${n.qn}`) }));
        const links = unfolding.flatMap(s => s.nodes.filter(n => drawn.has(n.qn)).map(n => n.qn));
        const children = unfolding.flatMap(s => elements(s.nodes, id, node.module, s.side));
        if (unfolding.length) tree.open = unfolding.map(s => s.side);
        if (links.length) tree.links = links;
        if (children.length) tree.children = children;
        return tree;
    };
    const seed: TreeNode = { id: '~', type: 'seed', label: name, fact: `${modules.length} module${modules.length === 1 ? '' : 's'}`, count: modules.length, relevance: 1 };
    if (open(seed.id)) seed.children = kept(seed.id, modules.sort((a, b) => index.relevanceOf(b) - index.relevanceOf(a) || a.localeCompare(b)), module => `~/${module}`).map(module => {
        const members = order(roots.filter(n => n.module === module));
        const id = `~/${module}`;
        const kinds = [...Map.groupBy(members, n => n.kind)].map(([kind, list]) => `${list.length} ${list.length === 1 ? kindLabel(kind) : plural(kind).toLowerCase()}`);
        const tree: TreeNode = { id, type: 'module', qn: module, label: module, fact: kinds.join(' · ') || (filled.has(module) ? '' : 'empty'), count: members.length, relevance: index.relevanceOf(module) };
        const inside = open(id) ? elements(kept(id, members, n => `${id}/${n.qn}`), id, module) : [];
        if (inside.length) tree.children = inside;
        return tree;
    });
    return seed;
}

const SIDES: Side[] = ['up', 'down'];

/**
 * The pyramid that draws these elements one after another and nothing else: each unfolds where the pyramid already
 * shows it, else its trail from the seed through its module is added. `ids` are the drawn nodes, undefined when the
 * entry level has no place for the element. With `folded` the elements stay folded: each stands in its module.
 */
export function trailOf(index: GraphIndex, settings: ViewSettings, focus: string[], folded = false): { unfolded: Set<string>, trail: Set<string>, ids: (string | undefined)[] } {
    const unfolded = new Set<string>();
    const trail = new Set(['~']);
    const grow = (open: string[]) => flatten(growTree(index, settings, new Set([...unfolded, ...open]), undefined, trail));
    const ids = focus.map(qn => {
        const declaration = index.declaration(qn);
        const sides = grow([]).filter(n => n.type === 'element').flatMap(n => SIDES.map(side => sideId(n.id, side)));
        const found = [...grow(sides), ...grow(revealPath(index, settings, declaration))].find(n => n.qn === declaration);
        if (!found) return undefined;
        const parts = found.id.split('/');
        parts.forEach((_, i) => {
            const id = parts.slice(0, i + 1).join('/');
            trail.add(id);
            // below the module, every node on the way opens the side the element stands on
            if (found.side && i > 1 && id !== found.id) trail.add(sideId(id, found.side));
        });
        if (found.type === 'module' && !folded) unfolded.add(found.id);
        if (found.type === 'element' && !folded) for (const side of SIDES) unfolded.add(sideId(found.id, side));
        return found.id;
    });
    return { unfolded, trail, ids };
}

/** The level whose band holds declarations of this kind. */
export function lensOf(kind: string): Lens | undefined {
    return (Object.keys(LENSES) as Lens[]).find(lens => LENSES[lens].kinds.includes(kind));
}

function flatten(tree: TreeNode): TreeNode[] {
    return [tree, ...(tree.children ?? []).flatMap(flatten)];
}

/** The node ids to unfold so that the declaration of an element shows in its module, if it is of the entry level. */
export function revealPath(index: GraphIndex, settings: ViewSettings, qn: string): string[] {
    const node = index.nodes.get(index.declaration(qn));
    if (node?.kind === 'Module') return ['~', `~/${node.qn}`];
    if (!node || !LENSES[settings.lens].kinds.includes(node.kind)) return [];
    return ['~', `~/${node.module}`];
}

/** Declarations stand in the order of their kinds: by layer, and within a layer the kind a developer looks for first. */
const KIND_ORDER = [
    'Role', 'Actor', 'Tenant', 'Entity', 'ValueType', 'Enum', 'Action', 'Event', 'Machine', 'Job',
    'UseCase', 'Query', 'Projection', 'External', 'Interface', 'Page', 'Navigation', 'Flow', 'Messages'
];

function rank(kind: string): number {
    const at = KIND_ORDER.indexOf(kind);
    return at < 0 ? KIND_ORDER.length : at;
}

const PLURALS: Record<string, string> = { Query: 'Queries', Policy: 'Policies', Entity: 'Entities', UseCase: 'Use cases', ValueType: 'Value types', Messages: 'Messages' };

/** A kind in the plural: `Entities`, `Use cases`. */
export function plural(kind: string): string {
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

/** An element as it reads: its own properties and those of everything inside it. */
function reading(index: GraphIndex, qn: string): string {
    return JSON.stringify(index.nodes.get(qn)?.props) + index.children(qn).map(child => child.qn + reading(index, child.qn)).join('');
}

/** What a new model did to these elements: `added` when it is new, `changed` when it or something inside it reads differently. */
export function modelPulse(before: GraphIndex, after: GraphIndex, qns: Iterable<string>): Map<string, 'added' | 'changed'> {
    const pulse = new Map<string, 'added' | 'changed'>();
    for (const qn of new Set(qns)) {
        if (!before.nodes.has(qn)) pulse.set(qn, 'added');
        else if (reading(before, qn) !== reading(after, qn)) pulse.set(qn, 'changed');
    }
    return pulse;
}

export type ChangeMark = 'added' | 'changed' | 'removed';

/** Model changes to mark on the canvas, such as a model diff (`@appling/model/diff`) or the changes of an AI session. */
export interface MarkedChanges {
    added: string[];
    changed: string[];
    /** Removed elements; they are marked only when the index has them, such as one built from `withRemoved`, and then drawn ghosted. */
    removed?: string[];
}

/**
 * The declarations a model change touches: `added` or `removed` when the declaration itself is new or gone, else
 * `changed`. Members lift to their declaration. Removed elements count only when the index still has them. With
 * `modules`, the modules (and their parent modules) that hold a marked declaration are marked `changed` too, so the
 * changes show before their module unfolds.
 */
export function changeMarks(index: GraphIndex, changes: MarkedChanges, modules = false): Map<string, ChangeMark> {
    const marks = new Map<string, ChangeMark>();
    for (const qn of changes.added) if (index.nodes.has(qn) && index.declaration(qn) === qn) marks.set(qn, 'added');
    for (const qn of changes.removed ?? []) if (index.nodes.has(qn) && index.declaration(qn) === qn) marks.set(qn, 'removed');
    for (const qn of [...changes.added, ...changes.changed, ...changes.removed ?? []]) {
        if (index.nodes.has(qn) && !marks.has(index.declaration(qn))) marks.set(index.declaration(qn), 'changed');
    }
    if (modules) {
        for (const qn of [...marks.keys()]) {
            for (const module of index.lineage(qn).slice(1)) if (!marks.has(module)) marks.set(module, 'changed');
        }
    }
    return marks;
}

/** Words for the implementation states, for marks and their tooltips. */
export const IMPLEMENTATION_LABELS: Record<ImplementationState, string> = {
    implemented: 'implemented', partial: 'partly implemented: open registry tasks or code written against an older version', unimplemented: 'not implemented'
};

/**
 * The implementation state the canvas draws per declaration: the declaration's own and its members' rolled up
 * (`rollupState`), and per module that of its declarations.
 */
export function implementationMarks(index: GraphIndex, states: Record<string, { state: ImplementationState }>): Map<string, ImplementationState> {
    const byDeclaration = new Map<string, ImplementationState[]>();
    for (const [qn, { state }] of Object.entries(states)) {
        const node = index.nodes.get(qn);
        if (!node || node.kind === 'Module') continue;
        const declaration = index.declaration(qn);
        byDeclaration.set(declaration, [...byDeclaration.get(declaration) ?? [], state]);
    }
    const marks = new Map<string, ImplementationState>();
    const byModule = new Map<string, ImplementationState[]>();
    for (const [qn, list] of byDeclaration) {
        const state = rollupState(list)!;
        marks.set(qn, state);
        for (const module of index.lineage(qn).slice(1)) byModule.set(module, [...byModule.get(module) ?? [], state]);
    }
    for (const [module, list] of byModule) marks.set(module, rollupState(list)!);
    return marks;
}

/** An element an agent session claimed or highlighted, drawn in the session's colour. */
export interface SessionMark {
    /** The element's qualified name. */
    element: string;
    color: string;
    /** The session's label. */
    label: string;
    session: string;
}

/** The declarations the canvas draws for session marks: a member's mark goes to its declaration; the first mark wins. */
export function sessionMarks(index: GraphIndex, marks: SessionMark[]): Map<string, SessionMark> {
    const result = new Map<string, SessionMark>();
    for (const mark of marks) {
        if (!index.nodes.has(mark.element)) continue;
        const declaration = index.declaration(mark.element);
        if (!result.has(declaration)) result.set(declaration, mark);
    }
    return result;
}

export type ViewKind = 'machine' | 'action' | 'usecase' | 'event' | 'node';

/** The element kinds each view is drawn for; the views of one kind come before `node`, which draws any declaration. */
export const VIEW_KINDS: Record<ViewKind, string[]> = {
    machine: ['Machine'], action: ['Action'], usecase: ['UseCase'], event: ['Event'], node: ['Module', ...Object.values(LENSES).flatMap(l => l.kinds)]
};

/** The innermost of an element and its ancestors that a view draws: where a bubble on the element points. */
export function anchorOf(index: GraphIndex, qn: string, drawn: Set<string>): string | undefined {
    return index.lineage(qn).find(q => drawn.has(q));
}

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
    timeout?: string;
    text?: string;
    handlers?: { error: string, call: CallData }[];
}

export type CardViewKind = 'action' | 'event';

const CARDS: Record<CardViewKind, (index: GraphIndex, qn: string) => Card[]> = { action: actionCards, event: eventCards };

/** The cards of every focused element, in focus order. */
export function cardView(index: GraphIndex, view: CardViewKind, focus: string[]): Card[] {
    return focus.filter(qn => index.nodes.has(qn)).flatMap(qn => CARDS[view](index, qn));
}

export interface FlowNode {
    id: string;
    label: string;
    /** The element a click selects. */
    qn?: string;
    tag?: string;
    note?: string;
}

export interface FlowEdge {
    from: string;
    to: string;
    label?: string;
    note?: string;
    /** The element a click on the label selects. */
    qn?: string;
    /** The element the edge stands for, such as a transition. */
    of?: string;
    /** What the label stands for when it is shortened, such as the states of a bundle. */
    title?: string;
}

/** A flowchart: states or steps as nodes, transitions or the step order as edges. */
export interface Flow {
    nodes: FlowNode[];
    edges: FlowEdge[];
}

export type FlowViewKind = 'machine' | 'usecase';

const FLOWS: Record<FlowViewKind, (index: GraphIndex, qn: string) => Flow> = { machine: machineFlow, usecase: useCaseFlow };

/** The flowcharts of every focused element, drawn as one. */
export function flowView(index: GraphIndex, view: FlowViewKind, focus: string[]): Flow {
    const flows = focus.filter(qn => index.nodes.has(qn)).map(qn => FLOWS[view](index, qn));
    return { nodes: flows.flatMap(f => f.nodes), edges: flows.flatMap(f => f.edges) };
}

export interface DiagramElement {
    qn: string;
    label: string;
}

/** A UML use case diagram of the whole application, in one system boundary. */
export interface UseCaseDiagram {
    actors: DiagramElement[];
    /** The use cases, then the actions their steps call as subfunctions. */
    useCases: (DiagramElement & { subfunction?: boolean })[];
    /** An actor starts a use case: one of the use case's policies names the actor or one of its roles. */
    associations: { actor: string, useCase: string }[];
    /** A step of a use case calls another use case or an action, which it always runs. */
    includes: { from: string, to: string }[];
}

export function useCaseDiagram(index: GraphIndex, level?: RelevanceLevel): UseCaseDiagram {
    const element = (node: GraphNode) => ({ qn: node.qn, label: shortName(node.qn, index) });
    const useCases = byRelevance(index, 'UseCase').filter(u => relevantFor(index, u.qn, level));
    // an actor that starts a drawn use case is drawn whatever its own relevance
    const starts = new Set(useCases.flatMap(useCase => startedBy(index, useCase.qn)));
    const actors = byRelevance(index, 'Actor').filter(a => starts.has(a.qn) || relevantFor(index, a.qn, level));
    const associations = useCases.flatMap(useCase => startedBy(index, useCase.qn).map(actor => ({ actor, useCase: useCase.qn })));
    // a call step always runs what it calls; a handler or the timeout of an await only in a special case
    const calls = (useCase: GraphNode) => ((useCase.data.steps as StepData[] | undefined) ?? []).flatMap(step => step.$type === 'CallStep' ? [step.call!.target] : [])
        .filter(target => target !== useCase.qn && ['UseCase', 'Action'].includes(index.nodes.get(target)?.kind ?? '') && relevantFor(index, target, level));
    const includes = useCases.flatMap(useCase => [...new Set(calls(useCase))].map(to => ({ from: useCase.qn, to })));
    const subfunctions = [...new Set(includes.map(i => i.to))].map(qn => index.nodes.get(qn)!).filter(n => n.kind === 'Action');
    return { actors: actors.map(element), useCases: [...useCases.map(element), ...subfunctions.map(n => ({ ...element(n), subfunction: true }))], associations, includes };
}

/** The declarations of a kind, the most relevant first. */
export function byRelevance(index: GraphIndex, kind: string): GraphNode[] {
    return index.graph.nodes.filter(n => n.kind === kind)
        .sort((a, b) => index.relevanceOf(b.qn) - index.relevanceOf(a.qn) || a.qn.localeCompare(b.qn));
}

/** The actors that start a use case: its `by` or one of its policies names the actor or one of its roles. */
function startedBy(index: GraphIndex, useCase: string): string[] {
    const named = new Set(index.graph.edges
        .filter(e => e.kind === 'uses' && index.parent(e.from) === useCase && index.nodes.get(e.from)!.kind === 'Policy')
        .map(e => e.to));
    return byRelevance(index, 'Actor').filter(a => [a.qn, ...(a.data.roles as string[] | undefined) ?? []].some(qn => named.has(qn))).map(a => a.qn);
}

export interface MenuItem {
    label: string;
    page: string;
    children: MenuItem[];
}

/** A navigation as a menu; pages that nothing else reaches stand in one without a qualified name. */
export interface ScreenMenu {
    qn?: string;
    label: string;
    items: MenuItem[];
}

/** A component of a page as a placeholder: what it shows and the actions it offers the actor. */
export interface ScreenPart {
    kind: 'list' | 'detail' | 'form';
    query?: string;
    projection?: string;
    /** The action a form submits. */
    submits?: string;
    /** The columns of a list, the fields of a detail or the inputs of a form. */
    fields: string[];
    actions: string[];
    /** For a list: the page a row opens, the one that details records of the same entity. */
    opens?: string;
}

export interface Screen extends DiagramElement {
    route: string;
    shows?: string;
    parts: ScreenPart[];
    /** Each flow this page is a step of: the use case, the step from 1, the steps and the next page. */
    flows: { flow: string, label: string, step: number, of: number, next?: string }[];
}

/** The wireframe of what one actor sees: the menus and the screens the actor reaches. */
export interface ScreenFlow {
    menus: ScreenMenu[];
    screens: Screen[];
}

interface ComponentData {
    $type: 'ListView' | 'DetailView' | 'FormView';
    query?: string;
    projection?: string;
    picks?: string[];
    actions?: string[];
    submits?: string;
}

/**
 * The screens of an actor: the pages whose queries and projections it may read or whose actions it may run, each
 * with only the actions it may run, the navigations cut to those pages, the page a list row opens, and the steps of
 * the flows of the use cases it starts.
 */
export function screenFlow(index: GraphIndex, actor: string, level?: RelevanceLevel): ScreenFlow {
    const access = new Map(new Simulator(index.graph).access(actor).filter(a => !a.operation).map(a => [a.target, a.verdict]));
    const may = (qn: string) => (access.get(qn) ?? 'no') !== 'no';
    const parts = (page: GraphNode) => ((page.data.components ?? []) as ComponentData[]).map((c): ScreenPart => ({
        kind: c.$type === 'ListView' ? 'list' : c.$type === 'DetailView' ? 'detail' : 'form',
        query: c.query, projection: c.projection, submits: c.submits,
        fields: (c.submits ? index.children(c.submits).filter(m => m.kind === 'Param') : c.picks?.length ? c.picks.map(p => index.nodes.get(p)!) : index.children(c.projection ?? '').filter(m => m.kind === 'ProjectionField'))
            .map(m => localName(m.qn, index)),
        actions: (c.actions ?? []).filter(may).sort((a, b) => index.relevanceOf(b) - index.relevanceOf(a))
    })).filter(part => part.kind !== 'form' || may(part.submits!));
    const pages = index.graph.nodes.filter(n => n.kind === 'Page' && relevantFor(index, n.qn, level)).map(page => ({ page, parts: parts(page) }))
        .filter(({ page, parts }) => may(page.qn) || parts.some(p => p.actions.length || p.kind === 'form'));
    const shown = new Set(pages.map(p => p.page.qn));
    const flows = index.graph.nodes.filter(n => n.kind === 'Flow' && startedBy(index, String(n.data.usecase)).includes(actor));
    const source = (projection?: string) => projection && index.nodes.get(projection)?.data.source;
    const details = pages.filter(p => p.parts.some(part => part.kind === 'detail'));
    const screens = pages.map(({ page, parts }): Screen => ({
        qn: page.qn, label: shortName(page.qn, index), route: String(page.data.route), shows: page.data.shows as string | undefined,
        parts: parts.map(part => part.kind !== 'list' ? part : {
            ...part, opens: details.find(d => d.page !== page && d.parts.some(p => p.kind === 'detail' && source(p.projection) === source(part.projection)))?.page.qn
        }),
        flows: flows.flatMap(flow => {
            const steps = (flow.data.pages as string[]).filter(p => shown.has(p));
            const at = steps.indexOf(page.qn);
            return at < 0 ? [] : [{ flow: flow.qn, label: shortName(String(flow.data.usecase), index), step: at + 1, of: steps.length, next: steps[at + 1] }];
        })
    }));
    const items = (list: { label: string, page: string, children?: unknown[] }[]): MenuItem[] => list
        .map(item => ({ label: item.label, page: item.page, children: items((item.children ?? []) as typeof list) }))
        .filter(item => shown.has(item.page) || item.children.length);
    const menus: ScreenMenu[] = index.graph.nodes.filter(n => n.kind === 'Navigation')
        .map(nav => ({ qn: nav.qn, label: shortName(nav.qn, index), items: items(nav.data.items as { label: string, page: string }[]) }))
        .filter(menu => menu.items.length);
    const reached = new Set([
        ...menus.flatMap(menu => menuPages(menu.items)),
        ...screens.flatMap(s => [...s.flows.flatMap(f => f.next ?? []), ...s.parts.flatMap(p => p.opens ?? [])])
    ]);
    // a page nothing leads to stands below the page its route lies under, such as /admin/users below /admin
    const segments = (route: string) => route.split('/').filter(Boolean);
    const below = (route: string, parent: string) => segments(parent).length < segments(route).length && segments(parent).every((s, i) => s === segments(route)[i]);
    const itemOf = (items: MenuItem[], page: string): MenuItem | undefined => items.flatMap(item => item.page === page ? [item] : [itemOf(item.children, page) ?? []].flat())[0];
    const more: MenuItem[] = [];
    for (const screen of screens.filter(s => !reached.has(s.qn)).sort((a, b) => segments(a.route).length - segments(b.route).length)) {
        const parents = screens.filter(s => below(screen.route, s.route)).sort((a, b) => segments(b.route).length - segments(a.route).length);
        const parent = parents.map(p => itemOf([...menus.flatMap(m => m.items), ...more], p.qn)).find(item => item);
        (parent?.children ?? more).push({ label: screen.label, page: screen.qn, children: [] });
    }
    if (more.length) menus.push({ label: 'More', items: more });
    return { menus, screens };
}

function menuPages(items: MenuItem[]): string[] {
    return items.flatMap(item => [item.page, ...menuPages(item.children)]);
}

/**
 * The states of the machine's field type and its transitions: one edge per state a transition leaves, labelled
 * with the action or event that drives it, its guard and the jobs that run it.
 */
function machineFlow(index: GraphIndex, qn: string): Flow {
    const field = index.nodes.get(String(index.nodes.get(qn)!.data.field));
    const states = String((field?.data.type as TypeData | undefined)?.decl ?? '');
    const transitions = index.children(qn).filter(c => c.kind === 'Transition');
    const jobs = index.graph.nodes.filter(n => n.kind === 'Job');
    const edges = transitions.flatMap(transition => {
        const { action, event } = transition.data as { action?: string, event?: string };
        const guard = transition.props.guard as string | undefined;
        return (transition.props.from as string[]).map(from => {
            const running = jobs.filter(j => action && j.data.action === action && runsIn(j, `${states}.${from}`, states)).map(j => `job ${shortName(j.qn, index)}`);
            return {
                from: `${states}.${from}`, to: `${states}.${transition.props.to}`, label: action ? shortName(action, index) : `on ${shortName(event ?? '', index)}`,
                note: [guard && `when ${guard}`, ...running].filter(Boolean).join(' · ') || undefined, qn: action ?? event, of: transition.qn
            };
        });
    });
    const nodes = index.children(states).filter(c => c.kind === 'EnumLiteral').map(literal => {
        const name = localName(literal.qn, index);
        const tag = field?.props.default === name ? 'initial' : edges.some(e => e.from === literal.qn) ? undefined : 'final';
        return { id: literal.qn, label: name, qn: literal.qn, tag };
    });
    return { nodes, edges };
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

/**
 * The use case with its inputs, then its steps in order, each selecting what it calls or awaits; an error handler or
 * a timeout branches off its step to the call it makes.
 */
function useCaseFlow(index: GraphIndex, qn: string): Flow {
    const inputs = index.children(qn).filter(m => m.kind === 'Param').map(m => memberText(m, index)).join(', ');
    const nodes: FlowNode[] = [{ id: qn, label: shortName(qn, index), qn, tag: 'usecase', note: inputs || undefined }];
    const edges: FlowEdge[] = [];
    let previous = qn;
    const call = (id: string, target: string, from: string, edge: Omit<FlowEdge, 'from' | 'to'> = {}) => {
        nodes.push({ id, label: shortName(target, index), qn: target });
        edges.push({ from, to: id, ...edge });
    };
    ((index.nodes.get(qn)!.data.steps as StepData[] | undefined) ?? []).forEach((step, i) => {
        const id = `${qn}#${i + 1}`;
        if (step.$type === 'AwaitStep') {
            nodes.push({ id, label: `await ${shortName(step.event!, index)}`, qn: step.event });
            edges.push({ from: previous, to: id });
            if (step.call) call(`${id}.timeout`, step.call.target, id, { label: `timeout ${step.timeout}` });
        } else if (step.$type === 'TextStep') {
            nodes.push({ id, label: step.text! });
            edges.push({ from: previous, to: id });
        } else {
            call(id, step.call!.target, previous);
            for (const handler of step.handlers ?? []) call(`${id}.${handler.error}`, handler.call.target, id, { label: localName(handler.error, index), qn: handler.error });
        }
        previous = id;
    });
    return { nodes, edges };
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
