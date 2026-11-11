import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { layoutTree, type Placed } from '../layout.js';
import { relevanceLevel } from '@appling/model/relevance';
import type { Bubble } from '../protocol.js';
import type { ImplementationState } from '@appling/model/implementation';
import { anchorOf, changeMarks, growOrder, growTree, IMPLEMENTATION_LABELS, IMPLEMENTATION_TAGS, implementationMarks, sessionMarks, kindLabel, LENSES, revealPath, trailOf, type GraphIndex, type Lens, type MarkedChanges, type SessionMark, type TreeNode, type TreeRequest, type ViewSettings } from '../views.js';
import { BubbleView, LooseBubbles, memberOf, type BubbleStep } from './Bubble.js';

interface CanvasProps {
    index: GraphIndex;
    /** The seed's label, such as the workspace folder. */
    name?: string;
    /** Elements or modules to draw one after another, each unfolded in place; when given, the tree draws only their trails. */
    focus?: string[];
    selected?: string;
    settings: ViewSettings;
    bubbles?: Bubble[];
    /** Elements added, changed and removed, such as since the session started or a model diff; their declarations are marked, removed ones (when the index has them, see `withRemoved` in `@appling/model/diff`) ghosted. */
    changes?: MarkedChanges;
    /** Elements agent sessions claimed or highlighted: their declarations get a ring in the session's colour. */
    sessions?: SessionMark[];
    /** A click on a claim ring: jump to that session (its tab in Appling Desktop). Without it the ring is not clickable. */
    onSession?(session: string): void;
    /** How far each element is implemented (`@appling/model/implementation`): declarations and modules get a dot and a tag in the colour of their rolled up state. */
    implementation?: Record<string, { state: ImplementationState }>;
    /** Elements asked for by name and description, drawn as ghosts under the node they were asked for under. */
    requests?: TreeRequest[];
    /** The right click menu of the nodes; without it there is none. */
    menu?: NodeMenu;
    /** The place of the shown bubble among all, for its back and next buttons. */
    step?: BubbleStep;
    /** Changing it plays the marks of `changes` once more, such as on every step of the playbook player. */
    beat?: number;
    /**
     * A changed focus unfolds one node after another along the tree, the camera gliding slowly to each, so the eye
     * follows (the playbook player); `onGrown` once the last is in view, or at once when nothing new unfolds.
     */
    grow?: boolean;
    onGrown?(): void;
    /** A button in the top bar, beside the current node's line, such as generating the selected element (`hint` under it). */
    action?: { label: string, hint?: string, run(): void };
    onSelect(qn: string): void;
    onSettings(settings: ViewSettings): void;
    onOpenFile?(file: string, line: number): void;
}

/** What the right click menu of a node does. */
export interface NodeMenu {
    /** Shows the element or module in the inspector, to edit it there. */
    onEdit(qn: string): void;
    /** Removes the element or module, once the person confirmed it in the menu. */
    onRemove(qn: string): void;
    /** Asks an agent for a new element under `parent` (none: the model as a whole). */
    onRequest(request: { name: string, description: string, parent?: string }): void;
    onEditRequest(id: string, change: { name: string, description: string }): void;
    onRemoveRequest(id: string): void;
}

/** The open menu: on which node, where (in the canvas), and whether it shows its actions, a confirmation or a form. */
interface OpenMenu {
    node: TreeNode;
    /** The qn new elements go under. */
    parent?: string;
    x: number;
    y: number;
    mode: 'actions' | 'remove' | 'request' | 'editRequest';
}

interface Camera {
    x: number;
    y: number;
    k: number;
}

/** The smallest and the largest circle of each node type; relevance decides in between. */
const RADIUS: Record<TreeNode['type'], [number, number]> = { seed: [34, 34], module: [10, 22], group: [11, 18], element: [13, 30], request: [14, 14] };

function radius(node: TreeNode): number {
    const [low, high] = RADIUS[node.type];
    return low + (high - low) * node.relevance;
}
/** The widest a bubble grows, how long the camera takes to glide to a new place, and how slowly a growing focus unfolds. */
const BUBBLE = 520;
const GLIDE = 500;
const SLOW_GLIDE = 1100;
const UNFOLD = 900;

/** How long a folded node takes to shrink back into the node it hangs from (`.leaving` in canvas.css). */
const FOLD = 380;

type Drawn = Placed & { leaving?: boolean };

/**
 * The nodes placed now plus those placed before and no more, moved onto the nearest of their ancestors that stays.
 * All in one list in the order drawn before: React remounts a node that changes lists and moves one met out of
 * order, and either way its transition is lost.
 */
function folding(before: Placed[], now: Map<string, Placed>): Drawn[] {
    const kept = before.flatMap((p): Drawn[] => {
        if (now.has(p.node.id)) return [now.get(p.node.id)!];
        let stays = p.parent;
        while (stays && !now.has(stays.node.id)) stays = stays.parent;
        const to = stays && now.get(stays.node.id)!;
        return to ? [{ ...p, x: to.x, y: to.y, parent: to, leaving: true }] : [];
    });
    const drawn = new Set(before.map(p => p.node.id));
    return [...kept, ...[...now.values()].filter(p => !drawn.has(p.node.id))];
}

/** The letter of a change on its circle, as Source Control marks files. */
const CHANGE_LETTERS: Record<string, string> = { added: 'A', changed: 'M', removed: 'D' };

/** How far the labels reach right of the circle, so a press anywhere on them counts. */
const LABEL: Record<TreeNode['type'], number> = { seed: 0, module: 210, group: 140, element: 190, request: 190 };

/**
 * The model as a tree that grows from a seed: modules first, then the declarations of the lens, then on every
 * unfold what uses the unfolded declaration. Only what you unfold is drawn.
 */
export function ModelCanvas({ index, name, focus, selected, settings, bubbles = [], changes, sessions, onSession, implementation, requests, menu, action, onSelect, onSettings, onOpenFile, step, beat, grow, onGrown }: CanvasProps) {
    const box = useRef<HTMLDivElement>(null);
    const drag = useRef<{ x: number, y: number, moved: boolean }>(undefined);
    const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, k: 1 });
    const seen = useRef(camera);
    seen.current = camera;
    const glide = useRef<number>(undefined);
    const [current, setCurrent] = useState('~');
    const [start] = useState(() => initial(index, settings, focus));
    const [unfolded, setUnfolded] = useState(start.unfolded);
    const [trail, setTrail] = useState(start.trail);
    const [fitting, setFitting] = useState(true);
    /** The node whose children just grew, to bring into view once they are placed. */
    const [follow, setFollow] = useState<{ id: string, glide?: number }>();
    const growing = useRef<ReturnType<typeof setTimeout>>(undefined);
    const grown = useRef(onGrown);
    grown.current = onGrown;

    const [opened, setOpened] = useState<OpenMenu>();
    const [legend, setLegend] = useState(false);
    const tree = useMemo(() => growTree(index, settings, unfolded, name, trail, requests), [index, settings, unfolded, name, trail, requests]);
    const placed = useMemo(() => layoutTree(tree), [tree]);
    const byId = useMemo(() => new Map(placed.map(p => [p.node.id, p])), [placed]);
    // folded nodes shrink back into the nearest node that stays, then go (same keys, so the transition runs)
    const previous = useRef<Placed[]>([]);
    const [settled, setSettled] = useState(placed);
    const folds = useMemo(() => folding(previous.current, byId), [placed]);
    const leaving = folds.some(p => p.leaving);
    useEffect(() => {
        previous.current = placed;
        if (!leaving) return;
        const timer = setTimeout(() => setSettled(placed), FOLD);
        return () => clearTimeout(timer);
    }, [placed]);
    const drawing: Drawn[] = leaving && settled !== placed ? folds : placed;
    const here = byId.get(current) ?? byId.get('~')!;
    const lit = new Set(lineage(here).map(p => p.node.id));
    const chosen = selected && index.declaration(selected);
    const marks = useMemo(() => changes ? changeMarks(index, changes, true) : new Map<string, string>(), [index, changes]);
    const claimed = useMemo(() => sessions?.length ? sessionMarks(index, sessions) : new Map<string, SessionMark>(), [index, sessions]);
    const implemented = useMemo(() => implementation ? implementationMarks(index, implementation) : new Map<string, ImplementationState>(), [index, implementation]);

    const replant = () => {
        clearTimeout(growing.current);
        const next = initial(index, settings, focus);
        const added = grow && !matchMedia('(prefers-reduced-motion: reduce)').matches ? growOrder({ unfolded, trail }, next) : [];
        const land = () => {
            setUnfolded(next.unfolded);
            setTrail(next.trail);
            setCurrent(next.last ?? '~');
            if (added.length) return void (growing.current = setTimeout(() => grown.current?.(), UNFOLD));
            if (next.last) setFollow({ id: next.last, glide: grow ? SLOW_GLIDE : undefined });
            else setFitting(true);
            growing.current = setTimeout(() => grown.current?.(), 0);
        };
        if (!added.length) return land();
        // The camera glides once to where the new nodes will stand, and stays there while they grow one after another,
        // so the eye follows the growth instead of a camera that chases each node.
        const final = layoutTree(growTree(index, settings, next.unfolded, name, next.trail));
        const target = new Set([...added, next.last]);
        frame(final.filter(p => target.has(p.node.id)), Math.max(seen.current.k, 1), SLOW_GLIDE);
        let shown = new Set([...unfolded].filter(id => next.unfolded.has(id)));
        let path = new Set([...trail].filter(id => next.trail.has(id)));
        setUnfolded(shown);
        setTrail(path);
        const unfold = (i: number) => {
            const id = added[i];
            if (next.unfolded.has(id)) shown = new Set([...shown, id]);
            else path = new Set([...path, id]);
            setUnfolded(shown);
            setTrail(path);
            setCurrent(id);
            growing.current = setTimeout(() => i + 1 < added.length ? unfold(i + 1) : land(), UNFOLD);
        };
        growing.current = setTimeout(() => unfold(0), UNFOLD / 2);
    };

    useEffect(replant, [settings.lens, focus]);
    useEffect(() => () => clearTimeout(growing.current), []);

    /** A selection from the text, the search or the inspector unfolds the tree to its declaration when the lens has it. */
    useEffect(() => {
        if (!selected || focus || byId.get(current)?.node.qn === chosen) return;
        const path = revealPath(index, settings, selected);
        if (!path.length) return;
        const next = new Set([...unfolded, ...path]);
        const found = layoutTree(growTree(index, settings, next, name)).find(p => p.node.type !== 'seed' && p.node.qn === chosen && p.node.id.split('/').length <= 4);
        setUnfolded(next);
        if (found) {
            setCurrent(found.node.id);
            setFollow({ id: found.node.id });
        }
    }, [selected]);

    /** Moves the camera there smoothly, so the eye can follow; a pan or zoom by hand stops it. */
    const move = useCallback((to: Camera, duration = GLIDE) => {
        cancelAnimationFrame(glide.current!);
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) return setCamera(to);
        const [from, start] = [seen.current, performance.now()];
        const step = (now: number) => {
            const t = Math.min(1, (now - start) / duration);
            // slow glides ease in and out, so the eye can follow the whole way
            const e = duration > GLIDE ? (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2) : 1 - (1 - t) ** 3;
            setCamera({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, k: from.k + (to.k - from.k) * e });
            if (t < 1) glide.current = requestAnimationFrame(step);
        };
        glide.current = requestAnimationFrame(step);
    }, []);

    /** Frames these nodes between the toolbars, never closer than `most`. */
    const frame = useCallback((nodes: Placed[], most: number, duration?: number) => {
        const element = box.current;
        if (!element || !nodes.length) return;
        const xs = nodes.flatMap(p => [p.x - radius(p.node) - 8, p.x + radius(p.node) + 190]);
        const ys = nodes.flatMap(p => [p.y - radius(p.node) - 16, p.y + radius(p.node) + (p.node.type === 'seed' ? 80 : 24)]);
        const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        const [width, height] = [element.clientWidth, element.clientHeight - 130];
        const k = Math.min(most, (width / (right - left)) * 0.94, (height / (bottom - top)) * 0.94);
        move({ k, x: width / 2 - ((left + right) / 2) * k, y: 85 + height / 2 - ((top + bottom) / 2) * k }, duration);
    }, []);

    const fit = useCallback(() => frame(placed, 1.1), [frame, placed]);

    useEffect(() => {
        if (!fitting) return;
        setFitting(false);
        fit();
    }, [fitting, fit]);

    /**
     * After a node grew or folded, keep it and its children in view: pan to them, and zoom out only when they do not fit.
     * A slow follow (a growing focus) always glides there, so the camera moves along the tree.
     */
    useEffect(() => {
        const node = follow && byId.get(follow.id);
        const element = box.current;
        setFollow(undefined);
        if (!node || !element) return;
        const group = [node, ...placed.filter(p => p.parent === node)];
        const inside = group.every(p => {
            const [x, y] = [camera.x + p.x * camera.k, camera.y + p.y * camera.k];
            return x > 20 && x + 200 * camera.k < element.clientWidth - 20 && y > 90 && y < element.clientHeight - 50;
        });
        if (!inside || follow.glide) frame(group, camera.k, follow.glide);
    }, [follow, placed]);

    /** Wheel zoom around the pointer; React's wheel listener is passive, so the page would scroll too. */
    useEffect(() => {
        const element = box.current!;
        const wheel = (event: WheelEvent) => {
            event.preventDefault();
            cancelAnimationFrame(glide.current!);
            const rect = element.getBoundingClientRect();
            const [px, py] = [event.clientX - rect.left, event.clientY - rect.top];
            setCamera(c => {
                const k = Math.min(2.5, Math.max(0.15, c.k * Math.exp(-event.deltaY * 0.0015)));
                return { k, x: px - (px - c.x) * (k / c.k), y: py - (py - c.y) * (k / c.k) };
            });
        };
        element.addEventListener('wheel', wheel, { passive: false });
        return () => element.removeEventListener('wheel', wheel);
    }, []);

    const zoom = (factor: number) => setCamera(c => {
        const element = box.current!;
        const [px, py] = [element.clientWidth / 2, element.clientHeight / 2];
        const k = Math.min(2.5, Math.max(0.15, c.k * factor));
        return { k, x: px - (px - c.x) * (k / c.k), y: py - (py - c.y) * (k / c.k) };
    });

    /** A click unfolds or folds the node; on an element it also selects it, so the inspector shows it. */
    const press = (node: TreeNode) => {
        if (drag.current?.moved) return;
        setCurrent(node.id);
        if (node.type === 'element') onSelect(node.qn!);
        if (node.type === 'module') onSelect(node.qn!);
        if (node.count === 0 || node.cycle) return;
        setFollow({ id: node.id });
        const inside = (id: string) => id === node.id || id.startsWith(`${node.id}/`);
        if (unfolded.has(node.id) && (node.type !== 'element' || current === node.id || !node.children)) {
            setUnfolded(new Set([...unfolded].filter(id => !inside(id))));
            setTrail(new Set([...trail].filter(id => !id.startsWith(`${node.id}/`))));
        } else setUnfolded(new Set([...unfolded, node.id]));
    };

    const drawn = new Map(placed.filter(p => p.node.type !== 'seed' && p.node.type !== 'group').reverse().map(p => [p.node.qn!, p]));
    const anchored = bubbles.map(bubble => ({ bubble, anchor: index.nodes.has(bubble.target) ? anchorOf(index, bubble.target, new Set(drawn.keys())) : undefined }));

    /** The shown bubble makes the node it points at the current one and glides it to the top left, leaving room for the bubble below. */
    useEffect(() => {
        const anchor = anchored[0]?.anchor;
        const element = box.current;
        if (!anchor || !element) return;
        const p = drawn.get(anchor)!;
        setCurrent(p.node.id);
        const k = Math.max(seen.current.k, 1);
        const x = Math.max(40, (element.clientWidth - bubbleWidth(element)) / 2 + 24);
        move({ k, x: x - p.x * k, y: 120 - p.y * k });
    }, [bubbles[0]]);

    const crumbs = lineage(here);
    const info = here.node.type === 'element'
        ? `${here.node.qn} · ${kindLabel(here.node.kind!)} · ${relevanceLevel(here.node.relevance)}${here.node.fact ? ` · ${here.node.fact}` : ''}${here.node.cycle ? ' · already on this branch' : here.node.count ? ` · used by ${here.node.count}` : ' · used by nothing'}`
        : here.node.type === 'module' ? `module ${here.node.qn} · ${relevanceLevel(here.node.relevance)} · ${here.node.fact}`
        : here.node.type === 'group' ? `${here.node.count} ${here.node.label.toLowerCase()} · ${here.parent?.node.qn ?? ''}`
        : here.node.type === 'request' ? `requested: ${here.node.label} · waits for an agent to model it${here.node.fact ? ` · ${here.node.fact}` : ''}`
        : `${here.node.label} · ${here.node.fact}`;

    /** Opens the right click menu at the pointer, kept inside the canvas. */
    const openMenu = (node: TreeNode, event: React.MouseEvent) => {
        if (!menu || !box.current) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = box.current.getBoundingClientRect();
        const placedAt = byId.get(node.id);
        const parent = node.type === 'group' ? placedAt?.parent?.node.qn : node.qn;
        const x = Math.max(8, Math.min(event.clientX - rect.left, rect.width - 290));
        const y = Math.max(8, Math.min(event.clientY - rect.top, rect.height - 250));
        setOpened({ node, parent, x, y, mode: 'actions' });
    };

    return (
        <div
            className="tree-canvas"
            ref={box}
            onPointerDown={event => {
                if ((event.target as Element).closest('.node-menu')) return;
                setOpened(undefined);
                if (event.button === 0) drag.current = { x: event.clientX, y: event.clientY, moved: false };
            }}
            onContextMenu={event => openMenu(byId.get('~')!.node, event)}
            onPointerMove={event => {
                const start = drag.current;
                if (!start || !(event.buttons & 1)) return;
                const [dx, dy] = [event.clientX - start.x, event.clientY - start.y];
                if (!start.moved && Math.hypot(dx, dy) < 4) return;
                start.moved = true;
                drag.current = { x: event.clientX, y: event.clientY, moved: true };
                cancelAnimationFrame(glide.current!);
                setCamera(c => ({ ...c, x: c.x + dx, y: c.y + dy }));
            }}
            onPointerUp={() => setTimeout(() => { drag.current = undefined; })}
        >
            <svg className="tree" role="tree" aria-label={`${LENSES[settings.lens].label} tree`}>
                <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.k})`}>
                    <line className="ground" x1={-6000} x2={6000} y1={48} y2={48} />
                    <path className="roots" d="M 0 34 C -6 54, -26 60, -44 74 M 0 34 C 6 54, 26 60, 44 74 M 0 34 C 0 56, -4 70, -6 86" />
                    {drawing.filter(p => p.parent).map(p => (
                        <path key={`branch ${p.node.id}`} className={`branch${p.leaving ? ' leaving' : lit.has(p.node.id) ? ' lit' : ''}`} pathLength={1} style={{ d: `path("${branch(p)}")` } as React.CSSProperties} />
                    ))}
                    {drawing.map(p => p.leaving ? <TreeItem key={p.node.id} placed={p} current={false} chosen={false} unfolded={false} leaving onPress={() => {}} /> : (
                        <TreeItem key={p.node.id} placed={p} current={p.node.id === current} chosen={!!chosen && p.node.qn === chosen} unfolded={!!p.node.children} mark={p.node.qn && marks.get(p.node.qn) && [marks.get(p.node.qn), changes?.planned && 'planned', beat !== undefined && `beat-${beat % 2}`].filter(Boolean).join(' ')} session={p.node.qn ? claimed.get(p.node.qn) : undefined} onSession={onSession} implementation={p.node.qn && p.node.type !== 'group' ? implemented.get(p.node.qn) : undefined} onPress={press} onMenu={menu ? openMenu : undefined} />
                    ))}
                </g>
            </svg>
            {anchored.filter(a => a.anchor).map(({ bubble, anchor }, i) => {
                const p = drawn.get(anchor!)!;
                // Below the node, where its own branch runs, and never past the edges of the canvas.
                const x = camera.x + p.x * camera.k;
                const width = box.current ? bubbleWidth(box.current) : BUBBLE;
                const left = Math.max(8, Math.min(x - 24, (box.current?.clientWidth ?? 0) - width - 8));
                const style = { position: 'absolute', left, maxWidth: width, top: camera.y + (p.y + radius(p.node)) * camera.k + 10, '--tail': `${Math.max(10, x - left)}px` } as React.CSSProperties;
                return <BubbleView key={`${i} ${bubble.target} ${bubble.text}`} bubble={bubble} member={memberOf(bubble, anchor!)} style={style} tail="up" step={step} onOpenFile={onOpenFile} />;
            })}
            <LooseBubbles bubbles={anchored.filter(a => !a.anchor).map(a => a.bubble)} step={step} onOpenFile={onOpenFile} />
            {opened && menu && <MenuView key={`${opened.node.id} ${opened.mode}`} at={opened} menu={menu} requests={requests} onMode={mode => setOpened({ ...opened, mode })} onClose={() => setOpened(undefined)} />}
            {legend && <Legend />}
            <div className="tree-top">
                <nav className="lenses" aria-label="Lens">
                    {(Object.keys(LENSES) as Lens[]).map(key => (
                        <button key={key} className={key === settings.lens ? 'active' : ''} onClick={() => onSettings({ ...settings, lens: key })}>{LENSES[key].label}</button>
                    ))}
                </nav>
                <ol className="crumbs" aria-label="Path">
                    {crumbs.map(p => <li key={p.node.id}><button onClick={() => setCurrent(p.node.id)}>{p.node.label}</button></li>)}
                </ol>
                <p className="tree-info">{info}</p>
                {action && <div className="tree-action"><button onClick={action.run}>{action.label}</button>{action.hint && <span>{action.hint}</span>}</div>}
            </div>
            <div className="tree-bottom">
                <span className="hint">click a bud to unfold what uses it · click again to fold · drag to pan · scroll to zoom</span>
                <label className="tree-option"><input type="checkbox" checked={settings.linkEntities} onChange={e => onSettings({ ...settings, linkEntities: e.target.checked })} />link entities</label>
                <span className="zoom">{Math.round(camera.k * 100)}%</span>
                <button onClick={() => zoom(1 / 1.25)} aria-label="Zoom out">−</button>
                <button onClick={() => zoom(1.25)} aria-label="Zoom in">+</button>
                <button onClick={fit}>Fit</button>
                <button onClick={replant}>Replant</button>
                <button onClick={() => setLegend(!legend)} aria-pressed={legend}>Legend</button>
            </div>
        </div>
    );
}

function TreeItem({ placed, current, chosen, unfolded, mark, session, onSession, implementation, leaving, onPress, onMenu }: { placed: Placed, current: boolean, chosen: boolean, unfolded: boolean, mark?: string, session?: SessionMark, onSession?(session: string): void, implementation?: ImplementationState, leaving?: boolean, onPress(node: TreeNode): void, onMenu?(node: TreeNode, event: React.MouseEvent): void }) {
    const { node, x, y } = placed;
    const r = radius(node);
    const bud = node.count > 0 && !node.cycle && !unfolded;
    const classes = ['tree-item', node.type, node.type !== 'seed' && relevanceLevel(node.relevance), node.layer && `layer-${node.layer}`, current && 'current', chosen && 'chosen', node.cycle && 'cycle', unfolded && 'open', implementation === 'unimplemented' && 'not-generated', leaving && 'leaving', mark];
    const change = mark?.split(' ').find(c => c in CHANGE_LETTERS);
    // The state in words under the labels: requested, or how far the code is.
    const tag = node.type === 'request' ? { name: 'requested', text: 'requested · for an agent' } : implementation && { name: implementation, text: IMPLEMENTATION_TAGS[implementation] };
    const tagY = node.type === 'module' ? 28 : node.type === 'request' ? 21 : node.fact ? 34 : 21;
    return (
        <g
            className={classes.filter(Boolean).join(' ')}
            style={{ transform: `translate(${x}px, ${y}px)` }}
            role="treeitem"
            aria-expanded={node.count > 0 ? unfolded : undefined}
            aria-label={`${node.label}${node.kind && node.type === 'element' ? `, ${kindLabel(node.kind)}` : ''}${node.fact ? `, ${node.fact}` : ''}`}
            tabIndex={0}
            onClick={() => onPress(node)}
            onContextMenu={onMenu ? event => onMenu(node, event) : undefined}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPress(node); } }}
        >
            <g className="grow">
                <title>{node.qn ?? node.label}{node.type === 'element' ? `\n${kindLabel(node.kind!)}, ${relevanceLevel(node.relevance)}` : ''}{node.fact ? `\n${node.fact}` : ''}{session ? `\nClaimed by ${session.label}` : ''}{implementation ? `\nCode: ${IMPLEMENTATION_LABELS[implementation]}` : ''}</title>
                {session && <circle className={`session-ring${onSession ? ' jump' : ''}`} r={r + 5} style={{ stroke: session.color }}
                    onClick={onSession ? event => { event.stopPropagation(); onSession(session.session); } : undefined}><title>{`Claimed by ${session.label}${onSession ? '. Click to go to the session' : ''}`}</title></circle>}
                {node.type !== 'seed' && <rect className="hit" x={-r - 4} y={-r - 4} width={r + LABEL[node.type]} height={2 * r + 8} rx={r} />}
                {change && <circle className="change-halo" r={r + 9} />}
                <circle className="ring" r={r} />
                {change && (
                    <g className="change-badge" transform={`translate(${-r * 0.72} ${-r * 0.72})`}>
                        <circle r={8} />
                        <text y={3.5}>{CHANGE_LETTERS[change]}</text>
                    </g>
                )}
                {node.type === 'seed' ? (
                    <>
                        <text className="seed-name" y={-2}>{clip(node.label, 12)}</text>
                        <text className="seed-kind" y={12}>{node.fact}</text>
                    </>
                ) : (
                    <>
                        <text className="count" y={4}>{node.cycle ? '↺' : node.count || ''}</text>
                        {node.type === 'group'
                            ? <text className="group-label" x={r + 10} y={4}>{node.label}</text>
                            : node.type === 'module'
                            ? <>
                                <text className="name" x={r + 10} y={-1}>{clip(node.label, 24)}</text>
                                <text className="fact" x={r + 10} y={14}>{clip(node.fact, 30)}</text>
                            </>
                            : node.type === 'request'
                            ? <>
                                <text className="name" x={r + 10} y={-7}>{clip(node.label, 24)}</text>
                                {node.fact && <text className="fact" x={r + 10} y={7}>{clip(node.fact, 30)}</text>}
                            </>
                            : <>
                                <text className="name" x={r + 10} y={-7}>{clip(node.label, 24)}</text>
                                <text className="kind" x={r + 10} y={7}>{kindLabel(node.kind!)}</text>
                                {node.fact && <text className="fact" x={r + 10} y={20}>{clip(node.fact, 30)}</text>}
                            </>}
                    </>
                )}
                {bud && <circle className="bud" cy={-r} r={4} />}
                {implementation && <circle className={`impl impl-${implementation}`} cx={r * 0.72} cy={r * 0.72} r={4.5} />}
                {tag && (
                    <g className={`tag tag-${tag.name}`} transform={`translate(${r + 10} ${tagY})`}>
                        <circle className={`impl impl-${tag.name}`} cx={3.5} cy={-3.5} r={3.5} />
                        <text x={11}>{tag.text}</text>
                    </g>
                )}
            </g>
        </g>
    );
}

/** The right click menu: the node's actions, the confirmation of a removal, or the form of a request. */
function MenuView({ at, menu, requests, onMode, onClose }: { at: OpenMenu, menu: NodeMenu, requests?: TreeRequest[], onMode(mode: OpenMenu['mode']): void, onClose(): void }) {
    const { node } = at;
    const request = node.request ? requests?.find(r => r.id === node.request) : undefined;
    const [name, setName] = useState(at.mode === 'editRequest' ? request?.name ?? '' : '');
    const [description, setDescription] = useState(at.mode === 'editRequest' ? request?.description ?? '' : '');
    const done = (run: () => void) => {
        run();
        onClose();
    };
    const props = { className: 'node-menu', style: { left: at.x, top: at.y }, onKeyDown: (event: React.KeyboardEvent) => { if (event.key === 'Escape') onClose(); } };
    if (at.mode === 'remove') return (
        <div {...props} role="dialog" aria-label={`Remove ${node.qn}`}>
            <p>Remove <strong>{node.qn}</strong> from the model?</p>
            <div className="node-menu-row">
                <button className="danger" autoFocus onClick={() => done(() => menu.onRemove(node.qn!))}>Remove</button>
                <button onClick={onClose}>Keep</button>
            </div>
        </div>
    );
    if (at.mode === 'request' || at.mode === 'editRequest') return (
        <form {...props} className="node-menu node-form" aria-label="Request an element" onSubmit={event => {
            event.preventDefault();
            const asked = { name: name.trim(), description: description.trim() };
            if (asked.name) done(() => at.mode === 'request' ? menu.onRequest({ ...asked, parent: at.parent }) : menu.onEditRequest(node.request!, asked));
        }}>
            <p>{at.mode === 'editRequest' ? 'Edit the request' : `New element ${at.parent ? `under ${at.parent}` : 'in the model'}`}</p>
            <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Name, such as Invoice" aria-label="Name" />
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={4} placeholder="What it is and what it does, in your words" aria-label="Description" />
            <p className="node-menu-hint">An agent session models it from this and the place in the tree. Until then it shows as requested.</p>
            <div className="node-menu-row">
                <button type="submit" disabled={!name.trim()}>{at.mode === 'editRequest' ? 'Save' : 'Request it'}</button>
                <button type="button" onClick={onClose}>Cancel</button>
            </div>
        </form>
    );
    const editable = node.qn && node.type !== 'group';
    return (
        <div {...props} role="menu" aria-label={node.label}>
            {node.type === 'request' ? (
                <>
                    <button role="menuitem" autoFocus onClick={() => onMode('editRequest')}>Edit request…</button>
                    <button role="menuitem" className="danger" onClick={() => done(() => menu.onRemoveRequest(node.request!))}>Remove request</button>
                </>
            ) : (
                <>
                    {editable && <button role="menuitem" autoFocus onClick={() => done(() => menu.onEdit(node.qn!))}>Edit in the inspector</button>}
                    <button role="menuitem" autoFocus={!editable} onClick={() => onMode('request')}>New element…</button>
                    {editable && <button role="menuitem" className="danger" onClick={() => onMode('remove')}>Remove…</button>}
                </>
            )}
        </div>
    );
}

/** What every mark on the canvas means. */
function Legend() {
    const dot = (state: string, text: string) => <li key={state}><svg width="14" height="14" viewBox="-7 -7 14 14"><circle className={`impl impl-${state}`} r={4.5} /></svg>{text}</li>;
    const badge = (change: string, text: string) => <li key={change} className={change}><svg width="18" height="18" viewBox="-9 -9 18 18"><g className="change-badge"><circle r={8} /><text y={3.5}>{CHANGE_LETTERS[change]}</text></g></svg>{text}</li>;
    return (
        <div className="tree-legend" role="note" aria-label="Legend">
            <h4>Code</h4>
            <ul>
                {(Object.keys(IMPLEMENTATION_LABELS) as ImplementationState[]).map(state => dot(state, IMPLEMENTATION_LABELS[state]))}
                {dot('requested', 'requested: an agent models it from your description')}
            </ul>
            <h4>Changes</h4>
            <ul>
                {badge('added', 'added')}
                {badge('changed', 'changed')}
                {badge('removed', 'removed')}
                <li><svg width="18" height="18" viewBox="-9 -9 18 18"><circle className="legend-ring planned" r={7} /></svg>dashed: planned in a playbook step</li>
            </ul>
            <h4>Tree</h4>
            <ul>
                <li><svg width="18" height="18" viewBox="-9 -9 18 18"><circle className="legend-ring" r={6} /><circle className="bud" cy={-6} r={2.5} /></svg>bud: click to unfold what uses it</li>
                <li><span className="legend-glyph">↺</span>already on this branch</li>
                <li><svg width="18" height="18" viewBox="-9 -9 18 18"><circle className="legend-ring session" r={7} /></svg>ring in a session's colour: claimed by that agent session</li>
                <li><span className="legend-glyph">◯</span>bigger and bolder: more relevant; faded: peripheral</li>
            </ul>
            <p>Right click a node to edit, remove or request a new element.</p>
        </div>
    );
}

/** The trails of the focus with the last focused node; without a focus the seed, unfolded to the module when there is only one. */
function initial(index: GraphIndex, settings: ViewSettings, focus?: string[]): { unfolded: Set<string>, trail: Set<string>, last?: string } {
    if (focus) {
        const { unfolded, trail, ids } = trailOf(index, settings, focus);
        return { unfolded, trail, last: ids.findLast(id => id !== undefined) };
    }
    const open = new Set(['~']);
    const modules = growTree(index, settings, open).children ?? [];
    if (modules.length === 1) open.add(modules[0].id);
    return { unfolded: open, trail: new Set() };
}

function bubbleWidth(canvas: HTMLElement): number {
    return Math.min(BUBBLE, canvas.clientWidth - 16);
}

function lineage(placed: Placed): Placed[] {
    const path: Placed[] = [];
    for (let p: Placed | undefined = placed; p; p = p.parent) path.unshift(p);
    return path;
}

/** From the top of the parent's circle up to the bottom of the child's, leaving and arriving upright. */
function branch({ node, x, y, parent }: Placed): string {
    const [from, to] = [parent!.y - radius(parent!.node), y + radius(node)];
    const middle = (from + to) / 2;
    return `M ${parent!.x} ${from} C ${parent!.x} ${middle}, ${x} ${middle}, ${x} ${to}`;
}

function clip(text: string, length: number): string {
    return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
