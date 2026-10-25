import { useMemo, useState } from 'react';
import { kindLabel, LAYER_LABELS, LAYERS, search, type GraphIndex } from '@appling/viz/views';

interface SearchProps {
    index: GraphIndex;
    onSelect(qn: string): void;
}

const LIMIT = 200;

export function Search({ index, onSelect }: SearchProps) {
    const [query, setQuery] = useState('');
    const [layers, setLayers] = useState(LAYERS);
    const results = useMemo(() => search(index, query, layers), [index, query, layers]);
    const shown = results.slice(0, LIMIT);

    return (
        <div className="search">
            <input type="search" value={query} placeholder="Search actions, entities, pages…" aria-label="Search the model" onChange={e => setQuery(e.target.value)} />
            <div className="layers" role="group" aria-label="Layers">
                {LAYERS.map(l => (
                    <button key={l} aria-pressed={layers.includes(l)} className={`layer-${l}${layers.includes(l) ? ' active' : ''}`}
                        onClick={() => setLayers(layers.includes(l) ? layers.filter(x => x !== l) : LAYERS.filter(x => x === l || layers.includes(x)))}>
                        {LAYER_LABELS[l]}
                    </button>
                ))}
            </div>
            {LAYERS.map(layer => {
                const items = shown.filter(n => n.layer === layer);
                return items.length ? (
                    <section key={layer} className={`layer-${layer}`}>
                        <h3>{LAYER_LABELS[layer]}</h3>
                        <ul>
                            {items.map(n => (
                                <li key={n.qn}>
                                    <button className="result" onClick={() => onSelect(n.qn)}>
                                        <span>{n.qn}</span>
                                        <span className="muted">{kindLabel(n.kind)}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </section>
                ) : null;
            })}
            {results.length > LIMIT && <p className="muted">{results.length - LIMIT} more, refine the search</p>}
            {!results.length && <p className="muted">Nothing matches.</p>}
        </div>
    );
}
