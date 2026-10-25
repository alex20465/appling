import type { Card } from '../views.js';

interface CardProps {
    cards: Card[];
    selected?: string;
    onSelect(qn: string): void;
}

/** Cards of options and facts, such as one per state with what can be done there: click a title or a row to select its element. */
export function CardCanvas({ cards, selected, onSelect }: CardProps) {
    return (
        <div className="cards">
            {cards.map(card => (
                <section key={card.id} className={`card${card.qn === selected ? ' selected' : ''}`}>
                    <button className="card-title" onClick={() => onSelect(card.qn)}>
                        <span className="entity-name">{card.title}</span>
                        {card.tag && <span className="entity-tag">{card.tag}</span>}
                    </button>
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
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    ))}
                </section>
            ))}
        </div>
    );
}
