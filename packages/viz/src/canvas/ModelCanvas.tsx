import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { layoutTree, type Placed } from '../layout.js';
import { relevanceLevel } from '@appling/model/relevance';
import { growTree, kindLabel, LENSES, revealPath, type GraphIndex, type Lens, type TreeNode, type ViewSettings } from '../views.js';

interface CanvasProps {
    index: GraphIndex;
    /** The seed's label, such as the workspace folder. */
    name?: string;
    /** Elements or modules to unfold to at first. */
    focus?: string[];
    selected?: string;
    settings: ViewSettings;
    onSelect(qn: string): void;
    onSettings(settings: ViewSettings): void;
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
/** How far the labels reach right of the circle, so a press anywhere on them counts. */
const LABEL: Record<TreeNode['type'], number> = { seed: 0, module: 210, group: 140, element: 190 };

/**
 * The model as a tree that grows from a seed: modules first, then the declarations of the lens, then on every
 * unfold what uses the unfolded declaration. Only what you unfold is drawn.
 */
export function ModelCanvas({ index, name, focus, selected, settings, onSelect, onSettings }: CanvasProps) {
    const box = useRef<HTMLDivElement>(null);
    const drag = useRef<{ x: number, y: number, moved: boolean }>(undefined);
    const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, k: 1 });
    const [current, setCurrent] = useState('~');
    const [unfolded, setUnfolded] = useState<Set<string>>(() => initial(index, settings, focus));
    const [fitting, setFitting] = useState(true);
    /** The node whose children just grew, to bring into view once they are placed. */
    const [follow, setFollow] = useState<string>();

    const tree = useMemo(() => growTree(index, settings, unfolded, name), [index, settings, unfolded, name]);
    const placed = useMemo(() => layoutTree(tree), [tree]);
    const byId = useMemo(() => new Map(placed.map(p => [p.node.id, p])), [placed]);
    const here = byId.get(current) ?? byId.get('~')!;
    const lit = new Set(lineage(here).map(p => p.node.id));
    const chosen = selected && index.declaration(selected);

    useEffect(() => {
        setUnfolded(initial(index, settings, focus));
        setCurrent('~');
        setFitting(true);
    }, [settings.lens, focus]);

    /** A selection from the text, the search or the inspector unfolds the tree to its declaration when the lens has it. */
    useEffect(() => {
        if (!selected || byId.get(current)?.node.qn === chosen) return;
        const path = revealPath(index, settings, selected);
        if (!path.length) return;
        const next = new Set([...unfolded, ...path]);
        const found = layoutTree(growTree(index, settings, next, name)).find(p => p.node.type !== 'seed' && p.node.qn === chosen && p.node.id.split('/').length <= 4);
        setUnfolded(next);
        if (found) {
            setCurrent(found.node.id);
            setFollow(found.node.id);
        }
    }, [selected]);

    /** Frames these nodes between the toolbars, never closer than `most`. */
    const frame = useCallback((nodes: Placed[], most: number) => {
        const element = box.current;
        if (!element || !nodes.length) return;
        const xs = nodes.flatMap(p => [p.x - radius(p.node) - 8, p.x + radius(p.node) + 190]);
        const ys = nodes.flatMap(p => [p.y - radius(p.node) - 16, p.y + radius(p.node) + (p.node.type === 'seed' ? 80 : 24)]);
        const [left, right, top, bottom] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        const [width, height] = [element.clientWidth, element.clientHeight - 130];
        const k = Math.min(most, (width / (right - left)) * 0.94, (height / (bottom - top)) * 0.94);
        setCamera({ k, x: width / 2 - ((left + right) / 2) * k, y: 85 + height / 2 - ((top + bottom) / 2) * k });
    }, []);

    const fit = useCallback(() => frame(placed, 1.1), [frame, placed]);

    useEffect(() => {
        if (!fitting) return;
        setFitting(false);
        fit();
    }, [fitting, fit]);

    /** After a node grew or folded, keep it and its children in view: pan to them, and zoom out only when they do not fit. */
    useEffect(() => {
        const node = follow && byId.get(follow);
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
        setFollow(node.id);
        setUnfolded(open => {
            const next = new Set(open);
            if (next.has(node.id) && (node.type !== 'element' || current === node.id || !node.children)) {
                for (const id of next) if (id === node.id || id.startsWith(`${node.id}/`)) next.delete(id);
            } else next.add(node.id);
            return next;
        });
    };

    const crumbs = lineage(here);
    const info = here.node.type === 'element'
        ? `${here.node.qn} · ${kindLabel(here.node.kind!)} · ${relevanceLevel(here.node.relevance)}${here.node.fact ? ` · ${here.node.fact}` : ''}${here.node.cycle ? ' · already on this branch' : here.node.count ? ` · used by ${here.node.count}` : ' · used by nothing'}`
        : here.node.type === 'module' ? `module ${here.node.qn} · ${relevanceLevel(here.node.relevance)} · ${here.node.fact}`
        : here.node.type === 'group' ? `${here.node.count} ${here.node.label.toLowerCase()} · ${here.parent?.node.qn ?? ''}`
        : `${here.node.label} · ${here.node.fact}`;

    return (
        <div
            className="tree-canvas"
            ref={box}
            onPointerDown={event => { if (event.button === 0) drag.current = { x: event.clientX, y: event.clientY, moved: false }; }}
            onPointerMove={event => {
                const start = drag.current;
                if (!start || !(event.buttons & 1)) return;
                const [dx, dy] = [event.clientX - start.x, event.clientY - start.y];
                if (!start.moved && Math.hypot(dx, dy) < 4) return;
                start.moved = true;
                drag.current = { x: event.clientX, y: event.clientY, moved: true };
                setCamera(c => ({ ...c, x: c.x + dx, y: c.y + dy }));
            }}
            onPointerUp={() => setTimeout(() => { drag.current = undefined; })}
        >
            <svg className="tree" role="tree" aria-label={`${LENSES[settings.lens].label} tree`}>
                <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.k})`}>
                    <line className="ground" x1={-6000} x2={6000} y1={48} y2={48} />
                    <path className="roots" d="M 0 34 C -6 54, -26 60, -44 74 M 0 34 C 6 54, 26 60, 44 74 M 0 34 C 0 56, -4 70, -6 86" />
                    {placed.filter(p => p.parent).map(p => (
                        <path key={`branch ${p.node.id}`} className={`branch${lit.has(p.node.id) ? ' lit' : ''}`} pathLength={1} style={{ d: `path("${branch(p)}")` } as React.CSSProperties} />
                    ))}
                    {placed.map(p => (
                        <TreeItem key={p.node.id} placed={p} current={p.node.id === current} chosen={!!chosen && p.node.qn === chosen} unfolded={!!p.node.children} onPress={press} />
                    ))}
                </g>
            </svg>
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
                <button onClick={fit}>Fit</button>
                <button onClick={() => { setUnfolded(initial(index, settings, focus)); setCurrent('~'); setFitting(true); }}>Replant</button>
            </div>
        </div>
    );
}

function TreeItem({ placed, current, chosen, unfolded, onPress }: { placed: Placed, current: boolean, chosen: boolean, unfolded: boolean, onPress(node: TreeNode): void }) {
    const { node, x, y } = placed;
    const r = radius(node);
    const bud = node.count > 0 && !node.cycle && !unfolded;
    const classes = ['tree-item', node.type, node.type !== 'seed' && relevanceLevel(node.relevance), node.layer && `layer-${node.layer}`, current && 'current', chosen && 'chosen', node.cycle && 'cycle', unfolded && 'open'];
    return (
        <g
            className={classes.filter(Boolean).join(' ')}
            style={{ transform: `translate(${x}px, ${y}px)` }}
            role="treeitem"
            aria-expanded={node.count > 0 ? unfolded : undefined}
            aria-label={`${node.label}${node.kind && node.type === 'element' ? `, ${kindLabel(node.kind)}` : ''}${node.fact ? `, ${node.fact}` : ''}`}
            tabIndex={0}
            onClick={() => onPress(node)}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPress(node); } }}
        >
            <g className="grow">
                <title>{node.qn ?? node.label}{node.type === 'element' ? `\n${kindLabel(node.kind!)}, ${relevanceLevel(node.relevance)}` : ''}{node.fact ? `\n${node.fact}` : ''}</title>
                {node.type !== 'seed' && <rect className="hit" x={-r - 4} y={-r - 4} width={r + LABEL[node.type]} height={2 * r + 8} rx={r} />}
                <circle className="ring" r={r} />
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
                {bud && <circle className="bud" cy={-r} r={4} />}
            </g>
        </g>
    );
}

/** The seed, then each module whose declarations a single module tree would show anyway, then the revealed focus. */
function initial(index: GraphIndex, settings: ViewSettings, focus?: string[]): Set<string> {
    const open = new Set(['~', ...(focus ?? []).flatMap(qn => revealPath(index, settings, qn))]);
    const modules = growTree(index, settings, open).children ?? [];
    if (modules.length === 1) open.add(modules[0].id);
    return open;
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
