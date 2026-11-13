import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { layoutTree, type Placed } from '../layout.js';
import { relevanceLevel } from '@appling/model/relevance';
import type { Bubble } from '../protocol.js';
import type { ImplementationState } from '@appling/model/implementation';
import { anchorOf, changeMarks, modelPulse, growTree, IMPLEMENTATION_LABELS, IMPLEMENTATION_TAGS, implementationMarks, sessionMarks, kindLabel, LENSES, revealPath, trailOf, type GraphIndex, type Lens, type MarkedChanges, type SessionMark, type TreeNode, type ViewSettings } from '../views.js';
import { BubbleView, LooseBubbles, memberOf, type BubbleStep } from './Bubble.js';
import { leaves, loads, pathOf, sproutDelays, stem } from './plant.js';
import { play, setSound, soundOn } from './sound.js';

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
    /** A click on a claim ring: jump to that session (its terminal). Without it the ring is not clickable. */
    onSession?(session: string): void;
    /** How far each element is implemented (`@appling/model/implementation`): declarations and modules get a dot and a tag in the colour of their rolled up state. */
    implementation?: Record<string, { state: ImplementationState }>;
    /** The place of the shown bubble among all, for its back and next buttons. */
    step?: BubbleStep;
    /** More buttons in the bottom bar, such as one that opens a panel over the canvas (`pressed` while it is open). */
    buttons?: { label: string, pressed?: boolean, run(): void }[];
    onSelect(qn: string): void;
    onSettings(settings: ViewSettings): void;
    onOpenFile?(file: string, line: number): void;
}

interface Camera {
    x: number;
    y: number;
    k: number;
}

/** The smallest and the largest circle of each node type; relevance decides in between. */
const RADIUS: Record<TreeNode['type'], [number, number]> = { seed: [34, 34], module: [10, 22], group: [11, 18], element: [13, 30] };

function radius(node: TreeNode): number {
    const [low, high] = RADIUS[node.type];
    return low + (high - low) * node.relevance;
}
/** The widest a bubble grows, and how long the camera takes to glide to a new place. */
const BUBBLE = 520;
const GLIDE = 500;

/** How long a folded node takes to shrink back into the node it hangs from (`.leaving` in canvas.css). */
const FOLD = 380;

type Drawn = Placed & { leaving?: boolean };

/** A wave of rings around a node: it opened, folded, was added or changed. */
interface Ripple {
    key: number;
    id: string;
    kind: 'unfold' | 'fold' | 'touch' | 'added' | 'changed';
}

/** A leaf growing along +x from where it sits on the stem, and the bud on top of a node that can unfold. */
const LEAF = 'M 0 0 C 4 -6, 11 -6, 15 0 C 11 4, 4 4, 0 0 Z';
const BUD = 'M 0 2 C -5 -2, -3.5 -8, 0 -11 C 3.5 -8, 5 -2, 0 2 Z';

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
const LABEL: Record<TreeNode['type'], number> = { seed: 0, module: 210, group: 140, element: 190 };

/**
 * The model as a tree that grows from a seed: modules first, then the declarations of the lens, then on every
 * unfold what uses the unfolded declaration. Only what you unfold is drawn.
 */
export function ModelCanvas({ index, name, focus, selected, settings, bubbles = [], changes, sessions, onSession, implementation, buttons = [], onSelect, onSettings, onOpenFile, step }: CanvasProps) {
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
    const [follow, setFollow] = useState<{ id: string }>();

    const [legend, setLegend] = useState(false);
    const tree = useMemo(() => growTree(index, settings, unfolded, name, trail), [index, settings, unfolded, name, trail]);
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
    const sprouted = useRef(new Map<string, number>());
    const delays = useMemo(() => sproutDelays(placed, sprouted.current), [placed]);
    useEffect(() => { sprouted.current = delays; }, [delays]);
    const carried = useMemo(() => loads(placed), [placed]);
    const [ripples, setRipples] = useState<Ripple[]>([]);
    const wave = (waves: Omit<Ripple, 'key'>[]) => setRipples(now => [...now, ...waves.map((w, i) => ({ ...w, key: (now.at(-1)?.key ?? 0) + 1 + i }))].slice(-12));
    const [sound, setSoundOn] = useState(soundOn);

    /** A new model sends a wave from every drawn element it added or changed, with one soft sound for all. */
    const known = useRef(index);
    useEffect(() => {
        const before = known.current;
        known.current = index;
        if (before === index) return;
        const pulse = modelPulse(before, index, placed.flatMap(p => p.node.qn && p.node.type !== 'group' ? [p.node.qn] : []));
        if (!pulse.size) return;
        wave(placed.flatMap(p => p.node.type !== 'group' && pulse.has(p.node.qn!) ? [{ id: p.node.id, kind: pulse.get(p.node.qn!)! }] : []));
        play([...pulse.values()].includes('added') ? 'added' : 'changed');
    }, [index]);
    const here = byId.get(current) ?? byId.get('~')!;
    const lit = new Set(lineage(here).map(p => p.node.id));
    const chosen = selected && index.declaration(selected);
    const marks = useMemo(() => changes ? changeMarks(index, changes, true) : new Map<string, string>(), [index, changes]);
    const claimed = useMemo(() => sessions?.length ? sessionMarks(index, sessions) : new Map<string, SessionMark>(), [index, sessions]);
    const implemented = useMemo(() => implementation ? implementationMarks(index, implementation) : new Map<string, ImplementationState>(), [index, implementation]);

    const replant = () => {
        const next = initial(index, settings, focus);
        setUnfolded(next.unfolded);
        setTrail(next.trail);
        setCurrent(next.last ?? '~');
        if (next.last) setFollow({ id: next.last });
        else setFitting(true);
    };

    useEffect(replant, [settings.lens, focus]);

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
    const move = useCallback((to: Camera) => {
        cancelAnimationFrame(glide.current!);
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) return setCamera(to);
        const [from, start] = [seen.current, performance.now()];
        const step = (now: number) => {
            const t = Math.min(1, (now - start) / GLIDE);
            const e = 1 - (1 - t) ** 3;
            setCamera({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, k: from.k + (to.k - from.k) * e });
            if (t < 1) glide.current = requestAnimationFrame(step);
        };
        glide.current = requestAnimationFrame(step);
    }, []);

    /** Frames these nodes between the toolbars, never closer than `most`. */
    const frame = useCallback((nodes: Placed[], most: number) => {
        const element = box.current;
        if (!element || !nodes.length) return;
        const xs = nodes.flatMap(p => [p.x - radius(p.node) - 8, p.x + radius(p.node) + 190]);
        const ys = nodes.flatMap(p => [p.y - radius(p.node) - 16, p.y + radius(p.node) + (p.node.type === 'seed' ? 80 : 24)]);
        const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        const [width, height] = [element.clientWidth, element.clientHeight - 130];
        const k = Math.min(most, (width / (right - left)) * 0.94, (height / (bottom - top)) * 0.94);
        move({ k, x: width / 2 - ((left + right) / 2) * k, y: 85 + height / 2 - ((top + bottom) / 2) * k });
    }, []);

    const fit = useCallback(() => frame(placed, 1.1), [frame, placed]);

    useEffect(() => {
        if (!fitting) return;
        setFitting(false);
        fit();
    }, [fitting, fit]);

    /**
     * After a node grew or folded, keep it and its children in view: pan to them, and zoom out only when they do not fit.
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
        if (!inside) frame(group, camera.k);
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
        if (node.count === 0 || node.cycle) return wave([{ id: node.id, kind: 'touch' }]);
        setFollow({ id: node.id });
        const inside = (id: string) => id === node.id || id.startsWith(`${node.id}/`);
        const fold = unfolded.has(node.id) && (node.type !== 'element' || current === node.id || !node.children);
        if (fold) {
            setUnfolded(new Set([...unfolded].filter(id => !inside(id))));
            setTrail(new Set([...trail].filter(id => !id.startsWith(`${node.id}/`))));
        } else setUnfolded(new Set([...unfolded, node.id]));
        const kind = fold ? 'fold' : 'unfold';
        wave([{ id: node.id, kind }]);
        if (fold || !node.children) play(kind, { count: node.count, depth: node.id.split('/').length - 1, gesture: true });
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
        : `${here.node.label} · ${here.node.fact}`;

    const stems = drawing.filter(p => p.parent).map(p => ({ p, curve: stem(p, radius), state: p.leaving ? 'leaving' : lit.has(p.node.id) ? 'lit' : '' }));

    return (
        <div
            className="tree-canvas"
            ref={box}
            onPointerDown={event => {
                if (event.button === 0) drag.current = { x: event.clientX, y: event.clientY, moved: false };
            }}
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
                    <path className="roots" pathLength={1} d="M 0 34 C 0 56, -4 70, -6 86 M 0 34 C -6 54, -26 60, -44 74 M 0 34 C 6 54, 26 60, 44 74 M -22 59 C -30 68, -30 78, -36 88 M 24 60 C 34 66, 40 78, 38 90 M -3 66 C 4 74, 8 80, 8 92" />
                    {stems.map(({ p, curve, state }) => (
                        <path key={`branch ${p.node.id}`} className={`branch ${state}`} style={{ d: `path("${pathOf(curve)}")`, '--seedling': `path("${pathOf(curve.map((v, i) => curve[i % 2]) as typeof curve)}")`, strokeWidth: 1.4 + Math.min(4, Math.log2(1 + (carried.get(p.node.id) ?? 0)) * 0.9) + (state === 'lit' ? 1 : 0), animationDelay: `${delays.get(p.node.id) ?? 0}ms` } as React.CSSProperties} />
                    ))}
                    {stems.filter(s => s.state === 'lit').map(({ p, curve }) => (
                        <path key={`sap ${p.node.id}`} className="sap" pathLength={1} style={{ d: `path("${pathOf(curve)}")` } as React.CSSProperties} />
                    ))}
                    {stems.flatMap(({ p, curve, state }) => leaves(p.node.id, curve).map((leaf, i) => (
                        <g key={`leaf ${i} ${p.node.id}`} className={`leaf ${state}`} style={{ transform: `translate(${leaf.x}px, ${leaf.y}px) rotate(${leaf.angle}deg)` }}>
                            <path d={LEAF} style={{ animationDelay: `${(delays.get(p.node.id) ?? 0) + 380 + i * 120}ms, ${-i * 1300}ms` }} />
                        </g>
                    )))}
                    {ripples.map(ripple => {
                        const at = byId.get(ripple.id);
                        return at && (
                            <g key={ripple.key} className={`ripple ${ripple.kind}${at.node.layer ? ` layer-${at.node.layer}` : ''}`} style={{ transform: `translate(${at.x}px, ${at.y}px)` }}>
                                <circle r={radius(at.node) + 3} />
                                <circle r={radius(at.node) + 3} onAnimationEnd={() => setRipples(now => now.filter(r => r.key !== ripple.key))} />
                            </g>
                        );
                    })}
                    {drawing.map(p => p.leaving ? <TreeItem key={p.node.id} placed={p} current={false} chosen={false} unfolded={false} leaving onPress={() => {}} /> : (
                        <TreeItem key={p.node.id} placed={p} delay={delays.get(p.node.id)} current={p.node.id === current} chosen={!!chosen && p.node.qn === chosen} unfolded={!!p.node.children} mark={p.node.qn && marks.get(p.node.qn) && [marks.get(p.node.qn)].join(' ')} session={p.node.qn ? claimed.get(p.node.qn) : undefined} onSession={onSession} implementation={p.node.qn && p.node.type !== 'group' ? implemented.get(p.node.qn) : undefined} onPress={press} />
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
            </div>
            <div className="tree-bottom">
                <span className="hint">click a bud to unfold what uses it · click again to fold · drag to pan · scroll to zoom</span>
                <label className="tree-option"><input type="checkbox" checked={settings.linkEntities} onChange={e => onSettings({ ...settings, linkEntities: e.target.checked })} />link entities</label>
                <span className="zoom">{Math.round(camera.k * 100)}%</span>
                <button onClick={() => zoom(1 / 1.25)} aria-label="Zoom out">−</button>
                <button onClick={() => zoom(1.25)} aria-label="Zoom in">+</button>
                {buttons.map(b => <button key={b.label} onClick={b.run} aria-pressed={b.pressed}>{b.label}</button>)}
                <button onClick={fit}>Fit</button>
                <button onClick={replant}>Replant</button>
                <button onClick={() => setLegend(!legend)} aria-pressed={legend}>Legend</button>
                <button onClick={() => { setSound(!sound); setSoundOn(!sound); if (!sound) play('unfold', { count: 3, gesture: true }); }} aria-pressed={sound} title="Soft sounds when the plant grows, folds or changes">{sound ? 'Sound on' : 'Sound off'}</button>
            </div>
        </div>
    );
}

function TreeItem({ placed, delay = 0, current, chosen, unfolded, mark, session, onSession, implementation, leaving, onPress }: { placed: Placed, delay?: number, current: boolean, chosen: boolean, unfolded: boolean, mark?: string, session?: SessionMark, onSession?(session: string): void, implementation?: ImplementationState, leaving?: boolean, onPress(node: TreeNode): void }) {
    const { node, x, y, parent } = placed;
    const r = radius(node);
    // a new node comes out of the bud of the node it grows from
    const sprout = { animationDelay: `${delay}ms`, '--from-x': `${parent ? parent.x - x : 0}px`, '--from-y': `${parent ? parent.y - radius(parent.node) - y : 0}px` } as React.CSSProperties;
    const bud = node.count > 0 && !node.cycle && !unfolded;
    const classes = ['tree-item', node.type, node.type !== 'seed' && relevanceLevel(node.relevance), node.layer && `layer-${node.layer}`, current && 'current', chosen && 'chosen', node.cycle && 'cycle', unfolded && 'open', implementation === 'unimplemented' && 'not-generated', leaving && 'leaving', mark];
    const change = mark?.split(' ').find(c => c in CHANGE_LETTERS);
    // How far the code is, in words under the labels.
    const tag = implementation && { name: implementation, text: IMPLEMENTATION_TAGS[implementation] };
    const tagY = node.type === 'module' ? 28 : node.kind && node.fact ? 34 : 21;
    return (
        <g
            className={classes.filter(Boolean).join(' ')}
            style={{ transform: `translate(${x}px, ${y}px)` }}
            role="treeitem"
            aria-expanded={node.count > 0 ? unfolded : undefined}
            aria-label={`${node.label}${node.kind && node.type !== 'group' ? `, ${kindLabel(node.kind)}` : ''}${node.fact ? `, ${node.fact}` : ''}`}
            tabIndex={0}
            onClick={() => onPress(node)}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPress(node); } }}
        >
            <g className="grow" style={sprout}>
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
                            : <>
                                <text className="name" x={r + 10} y={-7}>{clip(node.label, 24)}</text>
                                <text className="kind" x={r + 10} y={7}>{kindLabel(node.kind!)}</text>
                                {node.fact && <text className="fact" x={r + 10} y={20}>{clip(node.fact, 30)}</text>}
                            </>}
                    </>
                )}
                {bud && <path className="bud" d={BUD} transform={`translate(0 ${-r})`} />}
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

/** What every mark on the canvas means. */
function Legend() {
    const dot = (state: string, text: string) => <li key={state}><svg width="14" height="14" viewBox="-7 -7 14 14"><circle className={`impl impl-${state}`} r={4.5} /></svg>{text}</li>;
    const badge = (change: string, text: string) => <li key={change} className={change}><svg width="18" height="18" viewBox="-9 -9 18 18"><g className="change-badge"><circle r={8} /><text y={3.5}>{CHANGE_LETTERS[change]}</text></g></svg>{text}</li>;
    return (
        <div className="tree-legend" role="note" aria-label="Legend">
            <h4>Code</h4>
            <ul>
                {(Object.keys(IMPLEMENTATION_LABELS) as ImplementationState[]).map(state => dot(state, IMPLEMENTATION_LABELS[state]))}
            </ul>
            <h4>Changes</h4>
            <ul>
                {badge('added', 'added')}
                {badge('changed', 'changed')}
                {badge('removed', 'removed')}
            </ul>
            <h4>Tree</h4>
            <ul>
                <li><svg width="18" height="18" viewBox="-9 -9 18 18"><circle className="legend-ring" cy={3} r={5} /><path className="bud" d={BUD} transform="translate(0 -2) scale(0.6)" /></svg>bud: click to unfold what uses it</li>
                <li><span className="legend-glyph">↺</span>already on this branch</li>
                <li><svg width="18" height="18" viewBox="-9 -9 18 18"><circle className="legend-ring session" r={7} /></svg>ring in a session's colour: claimed by that agent session</li>
                <li><span className="legend-glyph">◯</span>bigger and bolder: more relevant; faded: peripheral</li>
            </ul>
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

function clip(text: string, length: number): string {
    return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
