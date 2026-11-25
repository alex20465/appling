import { createElement, useMemo, type CSSProperties } from 'react';
import { iconOf } from '../icons.js';
import { layoutUseCases, type UseCaseChip } from '../layout.js';
import type { UseCaseDiagram } from '../views.js';

interface UseCaseProps {
    diagram: UseCaseDiagram;
    /** The name of the system boundary. */
    name: string;
    /** The icons of the view settings, by qualified name or kind. */
    icons?: Record<string, string>;
    selected?: string;
    onSelect(qn: string): void;
}

/** The cell of a chip that holds its icon, as on the level canvas. */
const CELL = 48;

/** A use case diagram in the chips of the level canvas: click an actor or a use case to select it and light its lines. */
export function UseCaseCanvas({ diagram, name, icons, selected, onSelect }: UseCaseProps) {
    const placed = useMemo(() => layoutUseCases(diagram), [diagram]);
    const lit = (...qns: string[]) => selected !== undefined && qns.includes(selected) ? ' lit' : '';
    /** The intro: the boundary, the actors and the use cases from the top, then the lines between those that stand. */
    const at = useMemo(() => new Map([
        ...placed.actors.map((a, i) => [a.qn, 200 + i * 140] as const),
        ...placed.useCases.map((u, i) => [u.qn, 260 + i * 90] as const)
    ]), [placed]);
    const delay = (...qns: string[]) => ({ '--delay': `${Math.max(...qns.map(q => at.get(q) ?? 0)) + (qns.length > 1 ? 260 : 0)}ms` }) as CSSProperties;
    const chip = (c: UseCaseChip, kind: 'Actor' | 'UseCase' | 'Action', layer: string, enter: string) => (
        <g key={c.qn} className={`uc-chip layer-${layer}${c.qn === selected ? ' selected' : ''}`} transform={`translate(${c.x} ${c.y})`} role="button" tabIndex={0}
            aria-label={`${c.label}, ${KIND[kind]}`} onClick={() => onSelect(c.qn)}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(c.qn); } }}>
            <g className={enter} style={delay(c.qn)}>
                <title>{c.qn}</title>
                <rect className="ring" x={-c.w} y={-c.h} width={2 * c.w} height={2 * c.h} rx={5} />
                <rect className="cell" x={3 - c.w} y={3 - c.h} width={CELL - 6} height={2 * c.h - 6} rx={3} />
                <line className="ring" x1={CELL - c.w} x2={CELL - c.w} y1={-c.h} y2={c.h} />
                <g className="icon" transform={`translate(${CELL / 2 - c.w - 9} -9) scale(0.75)`}>
                    {(iconOf(icons?.[c.qn] ?? icons?.[kind] ?? ICON[kind]) ?? []).map(([tag, attributes], i) => createElement(tag, { key: i, ...attributes }))}
                </g>
                <text className="name" x={CELL - c.w + 10} y={-3}>{c.label}</text>
                <text className="kind" x={CELL - c.w + 10} y={12}>{KIND[kind]}</text>
            </g>
        </g>
    );
    return (
        <div className="flow usecases">
            <svg width={placed.width} height={placed.height} role="img" aria-label="Use case diagram">
                <defs>
                    <marker id="include-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                        <path d="M 0 0 L 10 5 L 0 10 z" />
                    </marker>
                </defs>
                <rect className="uc-boundary fade" x={placed.boundary.x} y={placed.boundary.y} width={placed.boundary.width} height={placed.boundary.height} rx={10} />
                <text className="uc-system fade" x={placed.boundary.x + 12} y={placed.boundary.y - 8}>{name}</text>
                {placed.associations.map(a => <path key={`${a.actor} ${a.useCase}`} className={`uc-association draw${lit(a.actor, a.useCase)}`} d={a.path} pathLength={1} style={delay(a.actor, a.useCase)} />)}
                {placed.includes.map(i => (
                    <g key={`${i.from} ${i.to}`} className={`uc-include fade${lit(i.from, i.to)}`} style={delay(i.from, i.to)}>
                        <path d={i.path} markerEnd="url(#include-arrow)" />
                        <g transform={`translate(${i.label[0]} ${i.label[1]})`}>
                            <rect x={-28} y={-9} width={56} height={18} rx={9} />
                            <text y={3.5}>include</text>
                        </g>
                    </g>
                ))}
                {placed.useCases.map(u => chip(u, u.subfunction ? 'Action' : 'UseCase', u.subfunction ? 'behavior' : 'application', 'pop'))}
                {placed.actors.map(a => chip(a, 'Actor', 'experience', 'step-in'))}
            </svg>
        </div>
    );
}

const KIND = { Actor: 'actor', UseCase: 'use case', Action: 'action' };
const ICON = { Actor: 'user', UseCase: 'route', Action: 'zap' };
