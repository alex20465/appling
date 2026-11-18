import { useCallback, useEffect, useMemo, useRef, useState, createElement } from 'react';
import { FRAME, ROW, bandsOf, layoutTree, type Placed } from '../layout.js';
import { relevanceLevel } from '@appling/model/relevance';
import type { Bubble } from '../protocol.js';
import type { ImplementationState } from '@appling/model/implementation';
import { anchorOf, changeMarks, modelPulse, growTree, IMPLEMENTATION_LABELS, implementationMarks, sessionMarks, kindLabel, LENSES, peers, revealPath, sideId, trailOf, type GraphIndex, type Lens, type MarkedChanges, type SessionMark, type Side, type TreeNode, type ViewSettings } from '../views.js';
import { BubbleView, LooseBubbles, memberOf, type BubbleStep } from './Bubble.js';
import { iconOf } from '../icons.js';
import { Glyph } from './Glyph.js';
import { joins, pathOf, sproutDelays, traces } from './plant.js';
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
    buttons?: { label: string, icon?: string, pressed?: boolean, run(): void }[];
    onSelect(qn: string): void;
    onSettings(settings: ViewSettings): void;
    onOpenFile?(file: string, line: number): void;
}

interface Camera {
    x: number;
    y: number;
    k: number;
}

/** The camera zoomed by a factor, within its limits, around a point of the canvas that stays where it is. */
function scaled(c: Camera, factor: number, px: number, py: number): Camera {
    const k = Math.min(2.5, Math.max(0.15, c.k * factor));
    return { k, x: px - (px - c.x) * (k / c.k), y: py - (py - c.y) * (k / c.k) };
}

/** Half the height of the chip of each node type: every node of a type has one size, relevance shows in its outline. */
const HALF: Record<TreeNode['type'], number> = { seed: 34, module: 26, element: 26 };
/** A chip from its left to its right, around the node's place where the traces meet it: a cell of `CELL` on the left for the icon, the texts right of it. Inside the slots of `layout.ts`. */
const WIDE: Record<TreeNode['type'], number> = { seed: 34, module: 116, element: 116 };
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

/** The levels from the top of the pyramid down, each with its number. */
const LEVELS = (Object.keys(LENSES) as Lens[]).map((lens, i) => ({ lens, level: i + 1 })).reverse();
/** What the level rail takes on the left of the canvas. */
const RAIL = 72;
/** How far a module's frame reaches above and below the middle of its band. */
const FRAME_HALF = 44;

/**
 * The outline of a node: a chip with a cell in the colour of its layer on the left, for its icon, and its texts on the right, the traces meeting it
 * above and below the count. The seed is a square without a cell. Drawn around the node's place.
 */
function outline(node: Pick<TreeNode, 'type'>): string {
    const [h, w] = [HALF[node.type], WIDE[node.type]];
    const body = `M ${5 - w} ${-h} H ${w - 5} Q ${w} ${-h} ${w} ${5 - h} V ${h - 5} Q ${w} ${h} ${w - 5} ${h} H ${5 - w} Q ${-w} ${h} ${-w} ${h - 5} V ${5 - h} Q ${-w} ${-h} ${5 - w} ${-h} Z`;
    return node.type === 'seed' ? body : `${body} M ${CELL - w} ${-h} V ${h}`;
}

/** The tab that swells out of a node's edge to unfold one side of it, drawn on the top edge, and the arrow in it; the arrow turns around once that side is open. */
const TAB = 'M -30 0 C -18 0, -19 -16, -7 -16 L 7 -16 C 19 -16, 18 0, 30 0';
const ARROW = 'M -5.5 -5.5 L 0 -10.5 L 5.5 -5.5';

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
 * The model as a pyramid of five bands, one per level: the modules frame the declarations of the entry level, and
 * every declaration unfolds upwards to what rests on it and downwards to what it rests on. Only what you unfold is drawn.
 */
export function ModelCanvas({ index, name, focus, folded, selected, settings, bubbles = [], changes, sessions, onSession, implementation, buttons = [], onSelect, onSettings, onOpenFile, step }: CanvasProps) {
    const box = useRef<HTMLDivElement>(null);
    const drag = useRef<{ x: number, y: number, moved: boolean }>(undefined);
    /** The pointers that are down, for the pinch of two fingers. */
    const fingers = useRef(new Map<number, { x: number, y: number }>());
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
    const [options, setOptions] = useState(false);
    const tree = useMemo(() => growTree(index, settings, unfolded, name, trail), [index, settings, unfolded, name, trail]);
    const entry = LEVELS.find(l => l.lens === settings.lens)!.level;
    const placed = useMemo(() => layoutTree(tree, entry), [tree, entry]);
    const byId = useMemo(() => new Map(placed.map(p => [p.node.id, p])), [placed]);
    const bands = useMemo(() => new Map(bandsOf(placed).map(band => [band.level, band])), [placed, entry]);
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
    const [ripples, setRipples] = useState<Ripple[]>([]);
    const wave = (waves: Omit<Ripple, 'key'>[]) => setRipples(now => [...now, ...waves.map((w, i) => ({ ...w, key: (now.at(-1)?.key ?? 0) + 1 + i }))].slice(-12));
    const [sound, setSoundOn] = useState(soundOn);

    /** A new model sends a wave from every drawn element it added or changed, with one soft sound for all. */
    const known = useRef(index);
    useEffect(() => {
        const before = known.current;
        known.current = index;
        if (before === index) return;
        const pulse = modelPulse(before, index, placed.flatMap(p => p.node.qn ? [p.node.qn] : []));
        if (!pulse.size) return;
        wave(placed.flatMap(p => pulse.has(p.node.qn!) ? [{ id: p.node.id, kind: pulse.get(p.node.qn!)! }] : []));
        play([...pulse.values()].includes('added') ? 'added' : 'changed');
    }, [index]);
    const here = byId.get(current) ?? byId.get('~')!;
    const lit = new Set(lineage(here).map(p => p.node.id));
    const chosen = selected && index.declaration(selected);
    const related = useMemo(() => new Set(chosen && index.nodes.has(chosen) ? peers(index, chosen) : []), [index, chosen]);
    const counts = useMemo(() => Map.groupBy(index.graph.nodes.filter(n => index.declaration(n.qn) === n.qn), n => n.kind), [index]);
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
        const found = layoutTree(growTree(index, settings, next, name), entry).find(p => p.node.type !== 'seed' && p.node.qn === chosen);
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

    /** Frames these nodes between the toolbars and right of the level rail, never closer than `most`. */
    const frame = useCallback((nodes: Placed[], most: number) => {
        const element = box.current;
        if (!element || !nodes.length) return;
        const xs = nodes.flatMap(p => [p.x - WIDE[p.node.type] - 8, p.x + WIDE[p.node.type] + 8]);
        const ys = nodes.flatMap(p => [p.y - radius(p.node) - 16, p.y + radius(p.node) + (p.node.type === 'seed' ? 80 : 24)]);
        const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        const [width, height] = [element.clientWidth - RAIL, element.clientHeight - 80];
        const k = Math.min(most, (width / (right - left)) * 0.94, (height / (bottom - top)) * 0.94);
        move({ k, x: RAIL + width / 2 - ((left + right) / 2) * k, y: 30 + height / 2 - ((top + bottom) / 2) * k });
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
            return x - 120 * camera.k > RAIL && x + 120 * camera.k < element.clientWidth - 20 && y > 40 && y < element.clientHeight - 50;
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
            setCamera(c => scaled(c, Math.exp(-event.deltaY * 0.0015), px, py));
        };
        element.addEventListener('wheel', wheel, { passive: false });
        return () => element.removeEventListener('wheel', wheel);
    }, []);

    const zoom = (factor: number) => setCamera(c => scaled(c, factor, box.current!.clientWidth / 2, box.current!.clientHeight / 2));

    /** A finger or the button left: the finger that stays pans on from where it is, and never clicks. */
    const lift = (event: React.PointerEvent) => {
        fingers.current.delete(event.pointerId);
        const [rest] = fingers.current.values();
        if (rest) drag.current = { ...rest, moved: true };
        else setTimeout(() => { drag.current = undefined; });
    };

    /** Folds what these ids opened and everything under these nodes. */
    const fold = (keys: string[], under: string[]) => {
        const below = (id: string) => under.some(node => id.startsWith(`${node}/`) || id.startsWith(`${node}^`));
        setUnfolded(new Set([...unfolded].filter(id => !keys.includes(id) && !below(id))));
        setTrail(new Set([...trail].filter(id => !(keys.includes(id) && id.includes('^')) && !below(id))));
    };

    /** A click selects the node, so the inspector shows it; on a module it also unfolds or folds its frame. */
    const press = (node: TreeNode) => {
        if (drag.current?.moved) return;
        setCurrent(node.id);
        onSelect(node.qn!);
        if (node.type !== 'module' || node.count === 0) return wave([{ id: node.id, kind: 'touch' }]);
        setFollow({ id: node.id });
        if (node.children) fold([node.id], [node.id]);
        else setUnfolded(new Set([...unfolded, node.id]));
        const kind = node.children ? 'fold' : 'unfold';
        wave([{ id: node.id, kind }]);
        play(kind, { count: node.count, depth: 1, gesture: true });
    };

    /** A click on a bud unfolds that side of the declaration, or folds it again. */
    const grow = (node: TreeNode, side: Side) => {
        if (drag.current?.moved) return;
        setCurrent(node.id);
        setFollow({ id: node.id });
        const open = node.open?.includes(side);
        if (open) fold([sideId(node.id, side)], (node.children ?? []).filter(child => child.side === side).map(child => child.id));
        else setUnfolded(new Set([...unfolded, sideId(node.id, side)]));
        const kind = open ? 'fold' : 'unfold';
        wave([{ id: node.id, kind }]);
        play(kind, { count: node[side] ?? 0, depth: node.id.split('/').length - 1, gesture: true });
    };

    const drawn = new Map(placed.filter(p => p.node.type !== 'seed').reverse().map(p => [p.node.qn!, p]));
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

    /** The side of a level's block in the rail: a square as high as one row on screen, within what stays readable and out of the way. */
    const block = Math.max(28, Math.min(72, ROW * camera.k));
    const routed = useMemo(() => traces(drawing, radius), [drawing]);
    const joined = useMemo(() => joins(placed), [placed]);
    /** With a drawn declaration selected, what it is connected to stands out and the rest fades: the nodes its traces and joins lead to and those of its own level it belongs together with. */
    const picked = placed.find(p => p.node.type === 'element' && p.node.qn === chosen);
    const touches = (a: string, b: string) => !!picked && (a === picked.node.id || b === picked.node.id);
    const near = new Set(picked ? [
        picked.node.id,
        ...placed.filter(p => p.node.type === 'element' && p.parent?.node.type === 'element' && touches(p.node.id, p.parent.node.id)).flatMap(p => [p.node.id, p.parent!.node.id]),
        ...joined.filter(join => touches(join.from, join.to)).flatMap(join => [join.from, join.to]),
        ...placed.filter(p => related.has(p.node.qn!)).map(p => p.node.id)
    ] : []);
    const shade = (on: boolean) => picked ? on ? 'lit' : 'dim' : '';
    const stems = drawing.filter(p => routed.has(p.node.id)).map(p => ({ p, curve: routed.get(p.node.id)!, state: p.leaving ? 'leaving' : picked ? shade(touches(p.node.id, p.parent!.node.id)) : lit.has(p.node.id) ? 'lit' : '' }));

    return (
        <div
            className="tree-canvas"
            ref={box}
            onPointerDown={event => {
                fingers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
                if (event.button === 0) drag.current = { x: event.clientX, y: event.clientY, moved: fingers.current.size > 1 };
            }}
            onPointerMove={event => {
                if (fingers.current.size === 2 && fingers.current.has(event.pointerId)) {
                    const before = [...fingers.current.values()];
                    fingers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
                    const [a, b] = [...fingers.current.values()];
                    const rect = box.current!.getBoundingClientRect();
                    const middle = (p: typeof a, q: typeof a) => [(p.x + q.x) / 2 - rect.left, (p.y + q.y) / 2 - rect.top];
                    const [fx, fy] = middle(before[0], before[1]);
                    const [tx, ty] = middle(a, b);
                    const factor = Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, Math.hypot(before[0].x - before[1].x, before[0].y - before[1].y));
                    cancelAnimationFrame(glide.current!);
                    setCamera(c => { const to = scaled(c, factor, fx, fy); return { ...to, x: to.x + tx - fx, y: to.y + ty - fy }; });
                    return;
                }
                const start = drag.current;
                if (!start || !(event.buttons & 1)) return;
                const [dx, dy] = [event.clientX - start.x, event.clientY - start.y];
                if (!start.moved && Math.hypot(dx, dy) < 4) return;
                start.moved = true;
                drag.current = { x: event.clientX, y: event.clientY, moved: true };
                cancelAnimationFrame(glide.current!);
                setCamera(c => ({ ...c, x: c.x + dx, y: c.y + dy }));
            }}
            onPointerUp={lift}
            onPointerCancel={lift}
        >
            <svg className="tree" role="tree" aria-label={`Pyramid from ${LENSES[settings.lens].label}`}>
                <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.k})`}>
                    {LEVELS.map(({ lens, level }) => <rect key={lens} className={`band${level === entry ? ' entry' : ''}`} x={-20000} width={40000} y={bands.get(level)!.top} height={bands.get(level)!.bottom - bands.get(level)!.top} />)}
                    {joined.map(join => <path key={join.id} className={`branch join layer-${byId.get(join.from)?.node.layer} ${picked ? shade(touches(join.from, join.to)) : join.from === current || join.to === current ? 'lit' : ''}`} style={{ d: `path("${pathOf(join.points)}")`, strokeWidth: picked && touches(join.from, join.to) ? 2.4 : 1.4 } as React.CSSProperties} />)}
                    {stems.map(({ p, curve, state }) => (
                        <path key={`branch ${p.node.id}`} className={`branch layer-${p.parent!.node.layer} ${state}`} style={{ d: `path("${pathOf(curve)}")`, '--seedling': `path("${pathOf(curve.map(() => curve[0]))}")`, strokeWidth: state === 'lit' ? 2.4 : 1.4, animationDelay: `${delays.get(p.node.id) ?? 0}ms` } as React.CSSProperties} />
                    ))}
                    {stems.filter(s => s.state === 'lit').map(({ p, curve }) => (
                        <path key={`sap ${p.node.id}`} className="sap" pathLength={1} style={{ d: `path("${pathOf(curve)}")` } as React.CSSProperties} />
                    ))}
                    {ripples.map(ripple => {
                        const at = byId.get(ripple.id);
                        return at && (
                            <g key={ripple.key} className={`ripple ${ripple.kind}${at.node.layer ? ` layer-${at.node.layer}` : ''}`} style={{ transform: `translate(${at.x}px, ${at.y}px)` }}>
                                {[0, 1].map(i => <rect key={i} x={-WIDE[at.node.type] - 3} y={-radius(at.node) - 3} width={2 * WIDE[at.node.type] + 6} height={2 * radius(at.node) + 6} rx={7} onAnimationEnd={i ? () => setRipples(now => now.filter(r => r.key !== ripple.key)) : undefined} />)}
                            </g>
                        );
                    })}
                    {drawing.filter(p => p.node.type !== 'seed').map(p => p.leaving ? <TreeItem key={p.node.id} placed={p} current={false} chosen={false} leaving onPress={() => {}} onGrow={() => {}} /> : (
                        <TreeItem key={p.node.id} placed={p} delay={delays.get(p.node.id)} current={p.node.id === current} chosen={!!chosen && p.node.qn === chosen} related={related.has(p.node.qn!)} dim={!!picked && p.node.type === 'element' && !near.has(p.node.id)} icon={settings.icons?.[p.node.qn ?? ''] ?? settings.icons?.[p.node.kind ?? '']} mark={p.node.qn && marks.get(p.node.qn) && [marks.get(p.node.qn)].join(' ')} session={p.node.qn ? claimed.get(p.node.qn) : undefined} onSession={onSession} implementation={p.node.qn ? implemented.get(p.node.qn) : undefined} onPress={press} onGrow={grow} />
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
            <nav className="levels" aria-label="Entry level">
                {LEVELS.map(({ lens, level }) => (
                    <button key={lens} className={lens === settings.lens ? 'active' : ''} style={{ top: camera.y + (bands.get(level)!.top + bands.get(level)!.bottom) / 2 * camera.k - block / 2, width: block, height: block, fontSize: block * 0.36 }} aria-pressed={lens === settings.lens} aria-label={`L${level} ${LENSES[lens].label}: ${LENSES[lens].question}`} onClick={() => onSettings({ ...settings, lens })}>
                        L{level}
                        <span role="tooltip"><b>{LENSES[lens].question}</b>{LENSES[lens].label} · {LENSES[lens].kinds.reduce((all, kind) => all + (counts.get(kind)?.length ?? 0), 0)} declarations</span>
                    </button>
                ))}
            </nav>
            <div className="tree-bottom" role="toolbar" aria-label="Canvas">
                {options && (
                    <div className="tree-settings" role="group" aria-label="View settings">
                        <label><span><b>Link entities</b><small>Also draw the entities that only join two others</small></span><input type="checkbox" checked={settings.linkEntities} onChange={e => onSettings({ ...settings, linkEntities: e.target.checked })} /></label>
                        <label><span><b>Sound</b><small>Soft sounds when the model unfolds, folds or changes</small></span><input type="checkbox" checked={sound} onChange={() => { setSound(!sound); setSoundOn(!sound); if (!sound) play('unfold', { count: 3, gesture: true }); }} /></label>
                        <button onClick={replant}><Glyph name="rotate-ccw" size={14} /><span><b>Replant</b><small>Fold everything back to the start</small></span></button>
                    </div>
                )}
                <div className="tool-group">
                    <button onClick={() => zoom(1 / 1.25)} aria-label="Zoom out" data-tip="Zoom out"><Glyph name="minus" /></button>
                    <span className="zoom">{Math.round(camera.k * 100)}%</span>
                    <button onClick={() => zoom(1.25)} aria-label="Zoom in" data-tip="Zoom in"><Glyph name="plus" /></button>
                    <button onClick={fit} aria-label="Fit" data-tip="Fit everything into view"><Glyph name="maximize" /></button>
                </div>
                <div className="tool-group">
                    {buttons.map(b => <button key={b.label} className="labelled" onClick={b.run} aria-pressed={b.pressed}>{b.icon && <Glyph name={b.icon} />}{b.label}</button>)}
                    <button onClick={() => setLegend(!legend)} aria-label="Legend" aria-pressed={legend} data-tip="Legend"><Glyph name="info" /></button>
                    <button onClick={() => setOptions(!options)} aria-label="View settings" aria-pressed={options} data-tip="View settings"><Glyph name="sliders-horizontal" /></button>
                </div>
            </div>
        </div>
    );
}

function TreeItem({ placed, delay = 0, current, chosen, related, dim, icon, mark, session, onSession, implementation, leaving, onPress, onGrow }: { placed: Placed, delay?: number, current: boolean, chosen: boolean, related?: boolean, dim?: boolean, icon?: string, mark?: string, session?: SessionMark, onSession?(session: string): void, implementation?: ImplementationState, leaving?: boolean, onPress(node: TreeNode): void, onGrow(node: TreeNode, side: Side): void }) {
    const { node, x, y, parent } = placed;
    const r = radius(node);
    // a new node comes out of the bud of the node it unfolds from
    const from = parent?.node.type === 'element' ? parent.y + (node.side === 'down' ? r : -r) - y : 0;
    const sprout = { animationDelay: `${delay}ms`, '--from-x': `${parent ? parent.x - x : 0}px`, '--from-y': `${from}px` } as React.CSSProperties;
    const framed = node.type === 'module' && !!node.children;
    const open = (side: Side) => !!node.open?.includes(side);
    const classes = ['tree-item', node.type, relevanceLevel(node.relevance), node.layer && `layer-${node.layer}`, current && 'current', chosen && 'chosen', related && 'related', dim && 'dim', framed && 'open', implementation && `code-${implementation}`, leaving && 'leaving', mark];
    const change = mark?.split(' ').find(c => c in CHANGE_LETTERS);
    const glyph = icon && iconOf(icon);
    // the icon stands in the middle of the cell
    const w = WIDE[node.type];
    const cell = CELL / 2 - w;
    const text = CELL - w + 10;
    const half = (placed.width - FRAME) / 2;
    return (
        <g
            className={classes.filter(Boolean).join(' ')}
            style={{ transform: `translate(${x}px, ${y}px)` }}
            role="treeitem"
            aria-expanded={node.type === 'module' && node.count > 0 ? framed : undefined}
            aria-label={`${node.label}${node.type === 'element' ? `, ${kindLabel(node.kind!)}` : ''}${node.fact ? `, ${node.fact}` : ''}`}
            tabIndex={0}
            onClick={() => onPress(node)}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPress(node); } }}
        >
            {framed ? (
                <g className="grow" style={sprout}>
                    <title>{`module ${node.qn}\n${node.fact}`}</title>
                    <rect className="frame" x={-half} y={-FRAME_HALF} width={2 * half} height={2 * FRAME_HALF} rx={8} />
                    <text className="frame-name" x={12 - half} y={-FRAME_HALF - 6}>{node.label}</text>
                </g>
            ) : (
                <g className="grow" style={sprout}>
                    <title>{node.qn}{node.type === 'element' ? `\n${kindLabel(node.kind!)}, ${relevanceLevel(node.relevance)}` : ''}{node.fact ? `\n${node.fact}` : ''}{session ? `\nClaimed by ${session.label}` : ''}{implementation ? `\nCode: ${IMPLEMENTATION_LABELS[implementation]}` : ''}</title>
                    {session && <rect className={`session-ring${onSession ? ' jump' : ''}`} x={-w - 5} y={-r - 5} width={2 * w + 10} height={2 * r + 10} rx={9} style={{ stroke: session.color }}
                        onClick={onSession ? event => { event.stopPropagation(); onSession(session.session); } : undefined}><title>{`Claimed by ${session.label}${onSession ? '. Click to go to the session' : ''}`}</title></rect>}
                    {change && <rect className="change-halo" x={-w - 8} y={-r - 8} width={2 * w + 16} height={2 * r + 16} rx={12} />}
                    <path className="ring" d={outline(node)} />
                    <rect className="cell" x={3 - w} y={3 - r} width={CELL - 6} height={2 * r - 6} rx={3} />
                    {change && (
                        <g className="change-badge" transform={`translate(${-w} ${-r})`}>
                            <circle r={8} />
                            <text y={3.5}>{CHANGE_LETTERS[change]}</text>
                        </g>
                    )}
                    {node.type === 'module'
                        ? <>
                            <text className="name" x={text} y={-3}>{clip(node.label, 20)}</text>
                            <text className="fact" x={text} y={12}>{clip(node.fact, 25)}</text>
                        </>
                        : <>
                            <text className="name" x={text} y={-10}>{clip(node.label, 20)}</text>
                            <text className="kind" x={text} y={2}>{kindLabel(node.kind!)}</text>
                            {node.fact && <text className="fact" x={text} y={15}>{clip(node.fact, 25)}</text>}
                        </>}
                    {node.note && (
                        <g className="note-badge" transform={`translate(${w} ${-r})`}>
                            <title>{`${node.note.keyword}: ${node.note.text}`}</title>
                            <circle r={8} />
                            <g transform="translate(-5 -5) scale(0.42)">{NOTE.map(([tag, attributes], i) => createElement(tag, { key: i, ...attributes }))}</g>
                        </g>
                    )}
                    {glyph && <g className="icon" transform={`translate(${cell - 9} -9) scale(0.75)`}>{glyph.map(([tag, attributes], i) => createElement(tag, { key: i, ...attributes }))}</g>}
                    {!leaving && (['up', 'down'] as const).filter(side => node[side]).map(side => (
                        <g key={side} className={`bud-button${open(side) ? ' open' : ''}`} transform={`translate(0 ${side === 'up' ? -r : r})${side === 'down' ? ' rotate(180)' : ''}`} role="button" tabIndex={0}
                            aria-label={`${open(side) ? 'Fold' : 'Unfold'} the ${node[side]} ${side === 'up' ? 'above' : 'below'} ${node.label}`}
                            onClick={event => { event.stopPropagation(); onGrow(node, side); }}
                            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onGrow(node, side); } }}>
                            <title>{side === 'up' ? `${node[side]} above: what rests on it` : `${node[side]} below: what it rests on`}</title>
                            <path className="bud-disc" d={TAB} />
                            <path className="bud-arrow" d={ARROW} />
                        </g>
                    ))}
                </g>
            )}
        </g>
    );
}

const NOTE = iconOf('sticky-note')!;

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
            <h4>Levels</h4>
            <ul>
                {LEVELS.map(({ lens, level }) => <li key={lens}><b>L{level}</b> {LENSES[lens].label}: {LENSES[lens].question}</li>)}
            </ul>
            <h4>Pyramid</h4>
            <ul>
                <li><svg width="18" height="18" viewBox="-9 -9 18 18"><g className="bud-button" transform="translate(0 5) scale(0.6)"><path className="bud-disc" d={TAB} /><path className="bud-arrow" d={ARROW} /></g></svg>arrow on top: unfold what rests on it, on higher levels</li>
                <li><svg width="18" height="18" viewBox="-9 -9 18 18"><g className="bud-button" transform="translate(0 -5) scale(0.6) rotate(180)"><path className="bud-disc" d={TAB} /><path className="bud-arrow" d={ARROW} /></g></svg>arrow below: unfold what it rests on, on lower levels</li>
                <li><span className="legend-glyph">✥</span>drag to pan, scroll to zoom</li>
                <li><span className="legend-glyph">┄</span>dashed outline: belongs to the selected one on its own level</li>
                <li><svg width="18" height="18" viewBox="-9 -9 18 18"><circle className="legend-ring session" r={7} /></svg>ring in a session's colour: claimed by that agent session</li>
                <li><svg width="18" height="18" viewBox="-9 -9 18 18"><g className="note-badge"><circle r={8} /><g transform="translate(-5 -5) scale(0.42)">{NOTE.map(([tag, attributes], i) => createElement(tag, { key: i, ...attributes }))}</g></g></svg>note: an annotation, work the code has to do that the model does not state</li>
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
    if (modules.length <= 3) for (const module of modules) open.add(module.id);
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
