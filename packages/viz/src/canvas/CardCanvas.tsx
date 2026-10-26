import type { Bubble } from '../protocol.js';
import { anchorOf, type Card, type GraphIndex } from '../views.js';
import { BubbleView, LooseBubbles, memberOf, type BubbleStep } from './Bubble.js';

interface CardProps {
    index: GraphIndex;
    cards: Card[];
    selected?: string;
    bubbles?: Bubble[];
    /** The place of the shown bubble among all, for its back and next buttons. */
    step?: BubbleStep;
    onSelect(qn: string): void;
    onOpenFile?(file: string, line: number): void;
}

/** Cards of options and facts, such as what an action allows and does: click a title or a row to select its element. */
export function CardCanvas({ index, cards, selected, bubbles = [], onSelect, onOpenFile, step }: CardProps) {
    const drawn = new Set(cards.flatMap(card => [card.qn, ...card.sections.flatMap(s => s.rows.flatMap(r => r.qn ?? []))]));
    const placed = bubbles.map(bubble => ({ bubble, anchor: index.nodes.has(bubble.target) ? anchorOf(index, bubble.target, drawn) : undefined }));
    /** The bubbles at a title or row, each shown once, at the first place that draws its anchor. */
    const shown = new Set<Bubble>();
    const at = (qn?: string) => placed.filter(p => qn && p.anchor === qn && !shown.has(p.bubble)).map(({ bubble, anchor }) => {
        shown.add(bubble);
        return <BubbleView key={`${bubble.target} ${bubble.text}`} bubble={bubble} member={memberOf(bubble, anchor!)} reveal step={step} onOpenFile={onOpenFile} />;
    });
    return (
        <div className="cards">
            {cards.map(card => (
                <section key={card.id} className={`card${card.qn === selected ? ' selected' : ''}`}>
                    <button className="card-title" onClick={() => onSelect(card.qn)}>
                        <span className="entity-name">{card.title}</span>
                        {card.tag && <span className="entity-tag">{card.tag}</span>}
                    </button>
                    {at(card.qn)}
                    {card.sections.length === 0 && <span className="card-empty">No actions</span>}
                    {card.sections.map((section, i) => (
                        <div key={i}>
                            {section.title && <h4>{section.title}</h4>}
                            <ul>
                                {section.rows.map((row, j) => {
                                    const content = <>{row.text}{row.note && <span className="card-note">{row.note}</span>}</>;
                                    return (
                                        <li key={j}>
                                            {row.qn
                                                ? <button className={`card-row${row.qn === selected ? ' selected' : ''}`} onClick={() => onSelect(row.qn!)}>{content}</button>
                                                : <span className="card-row">{content}</span>}
                                            {at(row.qn)}
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    ))}
                </section>
            ))}
            <LooseBubbles bubbles={placed.filter(p => !p.anchor).map(p => p.bubble)} step={step} onOpenFile={onOpenFile} />
        </div>
    );
}
