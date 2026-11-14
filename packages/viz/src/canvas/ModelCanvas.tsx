import { useCallback, useEffect, useMemo, useRef, useState, createElement } from 'react';
import { layoutTree, type Placed } from '../layout.js';
import { relevanceLevel } from '@appling/model/relevance';
import type { Bubble } from '../protocol.js';
import type { ImplementationState } from '@appling/model/implementation';
import { anchorOf, changeMarks, modelPulse, growTree, IMPLEMENTATION_LABELS, implementationMarks, sessionMarks, kindLabel, LENSES, revealPath, trailOf, type GraphIndex, type Lens, type MarkedChanges, type SessionMark, type TreeNode, type ViewSettings } from '../views.js';
import { BubbleView, LooseBubbles, memberOf, type BubbleStep } from './Bubble.js';
import { iconOf } from '../icons.js';
import { loads, pathOf, sproutDelays, traces } from './plant.js';
import { play, setSound, soundOn } from './sound.js';

interface CanvasProps {
    index: GraphIndex;
    /** The seed's label, such as the workspace folder. */
    name?: string;
    /** Elements or modules to draw one after another, each unfolded in place; when given, the tree draws only their trails. */
    focus?: string[];
    /** The focused elements stay folded: only their trails, without what uses them. */
    folded?: boolean;
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

/** Half the height of the chip of each node type: every node of a type has one size, relevance shows in its outline. */
const HALF: Record<TreeNode['type'], number> = { seed: 34, module: 26, group: 16, element: 26 };
/** A chip from its left to its right, around the node's place where the traces meet it: a cell of `CELL` on the left for the icon, the texts right of it. Inside the slots of `layout.ts`. */
const WIDE: Record<TreeNode['type'], number> = { seed: 34, module: 116, group: 100, element: 116 };
const CELL = 48;

function radius(node: TreeNode): number {
    return HALF[node.type];
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

/** The level of each layer of the model, as the design names them. */
const LEVELS: Record<string, number> = { domain: 1, behavior: 2, application: 3, interface: 4, experience: 5 };

/**
 * The outline of a node: a chip with a cell in the colour of its layer on the left, for its icon, and its texts on the right, the traces meeting it
 * above and below the count. A declaration and a group of them have as many pins on each side as the level of their
 * layer, L1 to L5. The seed is a square chip with pins on three sides. Drawn around the node's place.
 */
function outline(node: Pick<TreeNode, 'type' | 'layer'>): string {
    const [h, w] = [HALF[node.type], WIDE[node.type]];
    const body = `M ${5 - w} ${-h} H ${w - 5} Q ${w} ${-h} ${w} ${5 - h} V ${h - 5} Q ${w} ${h} ${w - 5} ${h} H ${5 - w} Q ${-w} ${h} ${-w} ${h - 5} V ${5 - h} Q ${-w} ${-h} ${5 - w} ${-h} Z`;
    if (node.type === 'seed') return `${body} ${[-0.5, 0, 0.5].map(k => `M ${-h} ${k * h} h -7 M ${h} ${k * h} h 7 M ${k * h} ${h} v 7`).join(' ')}`;
    const pins = node.type === 'module' ? 0 : LEVELS[node.layer ?? ''] ?? 0;
    return `${body} M ${CELL - w} ${-h} V ${h} ${Array.from({ length: pins }, (_, i) => +(-h + 2 * h * (i + 1) / (pins + 1)).toFixed(1)).map(y => `M ${-w} ${y} h -5 M ${w} ${y} h 5`).join(' ')}`;
}

/** The bud on top of a node that can unfold. */
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

/**
 * The model as a tree that grows from a seed: modules first, then the declarations of the lens, then on every
 * unfold what uses the unfolded declaration. Only what you unfold is drawn.
 */
export function ModelCanvas({ index, name, focus, folded, selected, settings, bubbles = [], changes, sessions, onSession, implementation, buttons = [], onSelect, onSettings, onOpenFile, step }: CanvasProps) {
    const box = useRef<HTMLDivElement>(null);
    const drag = useRef<{ x: number, y: number, moved: boolean }>(undefined);
    const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, k: 1 });
    const seen = useRef(camera);
    seen.current = camera;
    const glide = useRef<number>(undefined);
    const [current, setCurrent] = useState('~');
    const [start] = useState(() => initial(index, settings, focus, folded));
    const [unfolded, setUnfolded] = useState(start.unfolded);
    const [trail, setTrail] = useState(start.trail);
    const [fitting, setFitting] = useState(true);
    /** The node whose children just grew, to bring into view once they are placed. */
    const [follow, setFollow] = useState(start.last ? { id: start.last } : undefined);

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
        const next = initial(index, settings, focus, folded);
        setUnfolded(next.unfolded);
        setTrail(next.trail);
        setCurrent(next.last ?? '~');
        // the shown bubble places the camera itself
        if (next.last && !bubbles.length) setFollow({ id: next.last });
        else if (!next.last) setFitting(true);
    };

    // while rendering, so no frame draws the new lens or focus with the old tree
    const planted = useRef({ lens: settings.lens, focus });
    if (planted.current.lens !== settings.lens || planted.current.focus !== focus) {
        planted.current = { lens: settings.lens, focus };
        replant();
    }

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
        const xs = nodes.flatMap(p => [p.x - WIDE[p.node.type] - 8, p.x + WIDE[p.node.type] + 8]);
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

    /** The shown bubble makes the node it points at the current one; the camera glides only when the node or the room for its bubble below is out of view. */
    useEffect(() => {
        const anchor = anchored[0]?.anchor;
        const element = box.current;
        if (!anchor || !element) return;
        const p = drawn.get(anchor)!;
        setCurrent(p.node.id);
        const { x, y, k } = seen.current;
        const [left, top] = [x + p.x * k, y + p.y * k];
        if (k >= 0.6 && left > 60 && left < element.clientWidth - 60 && top > 110 && top < element.clientHeight - 280) return;
        const zoom = Math.max(k, 0.6);
        move({ k: zoom, x: element.clientWidth / 2 - p.x * zoom, y: Math.max(140, element.clientHeight * 0.35) - p.y * zoom });
    }, [bubbles[0], anchored[0]?.anchor]);

    const crumbs = lineage(here);
    const info = here.node.type === 'element'
        ? `${here.node.qn} · ${kindLabel(here.node.kind!)} · ${relevanceLevel(here.node.relevance)}${here.node.fact ? ` · ${here.node.fact}` : ''}${here.node.cycle ? ' · already on this branch' : here.node.count ? ` · used by ${here.node.count}` : ' · used by nothing'}`
        : here.node.type === 'module' ? `module ${here.node.qn} · ${relevanceLevel(here.node.relevance)} · ${here.node.fact}`
        : here.node.type === 'group' ? `${here.node.count} ${here.node.label.toLowerCase()} · ${here.parent?.node.qn ?? ''}`
        : `${here.node.label} · ${here.node.fact}`;

    const routed = useMemo(() => traces(drawing, radius), [drawing]);
    const stems = drawing.filter(p => p.parent).map(p => ({ p, curve: routed.get(p.node.id)!, state: p.leaving ? 'leaving' : lit.has(p.node.id) ? 'lit' : '' }));

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
                    {stems.map(({ p, curve, state }) => (
                        <path key={`branch ${p.node.id}`} className={`branch ${state}`} style={{ d: `path("${pathOf(curve)}")`, '--seedling': `path("${pathOf(curve.map(() => curve[0]))}")`, strokeWidth: 1.4 + Math.min(4, Math.log2(1 + (carried.get(p.node.id) ?? 0)) * 0.9) + (state === 'lit' ? 1 : 0), animationDelay: `${delays.get(p.node.id) ?? 0}ms` } as React.CSSProperties} />
                    ))}
                    {stems.filter(s => s.state === 'lit').map(({ p, curve }) => (
                        <path key={`sap ${p.node.id}`} className="sap" pathLength={1} style={{ d: `path("${pathOf(curve)}")` } as React.CSSProperties} />
                    ))}
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
                        <TreeItem key={p.node.id} placed={p} delay={delays.get(p.node.id)} current={p.node.id === current} chosen={!!chosen && p.node.qn === chosen} unfolded={!!p.node.children} icon={settings.icons?.[p.node.type === 'seed' ? '~' : p.node.qn ?? ''] ?? settings.icons?.[p.node.kind ?? '']} mark={p.node.qn && marks.get(p.node.qn) && [marks.get(p.node.qn)].join(' ')} session={p.node.qn ? claimed.get(p.node.qn) : undefined} onSession={onSession} implementation={p.node.qn && p.node.type !== 'group' ? implemented.get(p.node.qn) : undefined} onPress={press} />
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

function TreeItem({ placed, delay = 0, current, chosen, unfolded, icon, mark, session, onSession, implementation, leaving, onPress }: { placed: Placed, delay?: number, current: boolean, chosen: boolean, unfolded: boolean, icon?: string, mark?: string, session?: SessionMark, onSession?(session: string): void, implementation?: ImplementationState, leaving?: boolean, onPress(node: TreeNode): void }) {
    const { node, x, y, parent } = placed;
    const r = radius(node);
    // a new node comes out of the bud of the node it grows from
    const sprout = { animationDelay: `${delay}ms`, '--from-x': `${parent ? parent.x - x : 0}px`, '--from-y': `${parent ? parent.y - radius(parent.node) - y : 0}px` } as React.CSSProperties;
    const bud = node.count > 0 && !node.cycle && !unfolded;
    const classes = ['tree-item', node.type, node.type !== 'seed' && relevanceLevel(node.relevance), node.layer && `layer-${node.layer}`, current && 'current', chosen && 'chosen', node.cycle && 'cycle', unfolded && 'open', implementation && `code-${implementation}`, leaving && 'leaving', mark];
    const change = mark?.split(' ').find(c => c in CHANGE_LETTERS);
    const glyph = icon && iconOf(icon);
    // the icon stands in the middle of the cell, in the seed above the name; a declaration already on its branch has its mark beside it
    const w = WIDE[node.type];
    const cell = node.type === 'seed' ? 0 : CELL / 2 - w;
    const text = CELL - w + 10;
    const [size, glyphX, glyphY] = node.type === 'seed' ? [16, 0, -23] : node.type === 'group' ? [14, node.cycle ? cell - 10 : cell, 0] : [18, cell, node.cycle ? -10 : 0];
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
                {session && <rect className={`session-ring${onSession ? ' jump' : ''}`} x={-w - 5} y={-r - 5} width={2 * w + 10} height={2 * r + 10} rx={9} style={{ stroke: session.color }}
                    onClick={onSession ? event => { event.stopPropagation(); onSession(session.session); } : undefined}><title>{`Claimed by ${session.label}${onSession ? '. Click to go to the session' : ''}`}</title></rect>}
                {change && <rect className="change-halo" x={-w - 8} y={-r - 8} width={2 * w + 16} height={2 * r + 16} rx={12} />}
                <path className="ring" d={outline(node)} />
                {node.type !== 'seed' && <rect className="cell" x={3 - w} y={3 - r} width={CELL - 6} height={2 * r - 6} rx={3} />}
                {change && (
                    <g className="change-badge" transform={`translate(${-w} ${-r})`}>
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
                        <text className="count" x={glyph && node.type === 'group' ? cell + 10 : cell} y={glyph && node.type !== 'group' ? 17 : 4}>{node.cycle ? '↺' : ''}</text>
                        {node.type === 'group'
                            ? <text className="group-label" x={text} y={4}>{node.label}</text>
                            : node.type === 'module'
                            ? <>
                                <text className="name" x={text} y={-3}>{clip(node.label, 20)}</text>
                                <text className="fact" x={text} y={12}>{clip(node.fact, 25)}</text>
                            </>
                            : <>
                                <text className="name" x={text} y={-10}>{clip(node.label, 20)}</text>
                                <text className="kind" x={text} y={2}>{kindLabel(node.kind!)}</text>
                                {node.fact && <text className="fact" x={text} y={15}>{clip(node.fact, 25)}</text>}
                            </>}
                    </>
                )}
                {glyph && <g className="icon" transform={`translate(${glyphX - size / 2} ${glyphY - size / 2}) scale(${size / 24})`}>{glyph.map(([tag, attributes], i) => createElement(tag, { key: i, ...attributes }))}</g>}
                {bud && <path className="bud" d={BUD} transform={`translate(0 ${-r})`} />}
            </g>
        </g>
    );
}

/** What every mark on the canvas means. */
function Legend() {
    const dot = (state: string, text: string) => <li key={state}><svg width="18" height="14" viewBox="-9 -7 18 14"><rect className={`legend-ring code-${state}`} x={-8} y={-5} width={16} height={10} rx={2} /></svg>{text}</li>;
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
            <h4>Layers</h4>
            <ul>
                {Object.entries(LEVELS).map(([layer, level]) => <li key={layer} className={`layer-${layer}`}><svg width="18" height="18" viewBox="-9 -9 18 18"><rect className="legend-ring layer" x={-6} y={-6} width={12} height={12} rx={2} /></svg>L{level} {layer}: {level} {level > 1 ? 'pins' : 'pin'} on each side of the chip</li>)}
            </ul>
            <h4>Tree</h4>
            <ul>
                <li><svg width="18" height="18" viewBox="-9 -9 18 18"><circle className="legend-ring" cy={3} r={5} /><path className="bud" d={BUD} transform="translate(0 -2) scale(0.6)" /></svg>bud: click to unfold what uses it</li>
                <li><span className="legend-glyph">↺</span>already on this branch</li>
                <li><svg width="18" height="18" viewBox="-9 -9 18 18"><circle className="legend-ring session" r={7} /></svg>ring in a session's colour: claimed by that agent session</li>
                <li><span className="legend-glyph">▭</span>bolder outline: more relevant; faded: peripheral</li>
            </ul>
        </div>
    );
}

/** The trails of the focus with the last focused node; without a focus the seed, unfolded to the module when there is only one. */
function initial(index: GraphIndex, settings: ViewSettings, focus?: string[], folded?: boolean): { unfolded: Set<string>, trail: Set<string>, last?: string } {
    if (focus) {
        const { unfolded, trail, ids } = trailOf(index, settings, focus, folded);
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
