import { useState, type CSSProperties } from 'react';
import type { MenuItem, Screen, ScreenFlow, ScreenPart } from '../views.js';
import { qualifiedOptions, Select } from './Select.js';

interface ScreenProps {
    flow: ScreenFlow;
    /** The application's name in the app bar. */
    name: string;
    /** The actor whose screens these are, and the others to switch to. */
    actor: string;
    actors: string[];
    selected?: string;
    onActor(actor: string): void;
    onSelect(qn: string): void;
}

/**
 * A clickable mockup of the application as one actor sees it: the navigation opens pages, a list row opens the page
 * that details it, a flow continues to its next page; the parts and buttons select their element of the model.
 */
export function ScreenCanvas({ flow, name, actor, actors, selected, onActor, onSelect }: ScreenProps) {
    const [open, setOpen] = useState<string>();
    /** The intro plays with the window; a page opened later cascades in at once. */
    const [moved, setMoved] = useState(false);
    const screen = flow.screens.find(s => s.qn === open) ?? flow.screens.find(s => s.qn === flow.menus[0]?.items[0]?.page) ?? flow.screens[0];
    const items = flow.menus.flatMap(menu => menu.items);
    const routeOf = (page: string) => flow.screens.find(s => s.qn === page)?.route;
    // the item of the open page, or of the page whose route the open one lies under, such as /leads for /leads/{id}
    const active = items.find(item => item.page === screen?.qn || pagesOf(item).includes(screen?.qn ?? ''))
        ?? items.find(item => screen?.route.startsWith(`${routeOf(item.page)}/`));
    // one row of sub navigation per level, from the main item down to the open page
    const levels: MenuItem[] = [];
    for (let at = active; at?.children.length; at = at.children.find(child => child.page === screen?.qn || pagesOf(child).includes(screen?.qn ?? ''))) levels.push(at);
    const go = (page: string) => {
        if (!flow.screens.some(s => s.qn === page)) return;
        setOpen(page);
        setMoved(true);
    };
    const mark = (qn?: string) => qn && qn === selected ? ' selected' : '';
    return (
        <div className="mock">
            <div className="mock-window">
                <div className="mock-chrome" aria-hidden="true">
                    <span className="mock-url">{screen ? sampleRoute(screen.route) : '/'}</span>
                </div>
                <header className="mock-appbar">
                    <strong className="mock-brand">{human(name)}</strong>
                    <nav className="mock-nav" aria-label="Main navigation">
                        {items.map((item, i) => (
                            <button key={`${item.label} ${item.page}`} style={order(i)} aria-current={item === active ? 'page' : undefined} onClick={() => go(item.page)}>{item.label}</button>
                        ))}
                    </nav>
                    <Select className="mock-account" value={actor} options={qualifiedOptions(actors)} label="Signed in as" align="end" lead={<span className="mock-avatar">{initials(actor)}</span>} onChange={onActor} />
                </header>
                {levels.map((level, depth) => (
                    <nav key={level.page} className={`mock-subnav${depth ? ' deep' : ''}`} aria-label={`${level.label} navigation`}>
                        {[...(depth ? [] : [level]), ...level.children].map(item => (
                            <button key={`${item.label} ${item.page}`} aria-current={item.page === screen?.qn || (item !== level && pagesOf(item).includes(screen?.qn ?? '')) ? 'page' : undefined} onClick={() => go(item.page)}>{item.label}</button>
                        ))}
                    </nav>
                ))}
                {screen && <Page key={screen.qn} screen={screen} start={moved ? 0 : 380} mark={mark} go={go} onSelect={onSelect} />}
            </div>
        </div>
    );
}

interface PageProps {
    screen: Screen;
    /** When the cascade of the page's parts starts, in ms. */
    start: number;
    mark(qn?: string): string;
    go(page: string): void;
    onSelect(qn: string): void;
}

function Page({ screen, start, mark, go, onSelect }: PageProps) {
    let at = 0;
    const next = () => order(at++);
    const button = (action: string, primary = false) => (
        <button key={action} className={`mock-button${primary ? ' primary' : ''}${mark(action)}`} title={`action ${action}`} onClick={event => { event.stopPropagation(); onSelect(action); }}>{human(action.split('.').at(-1)!)}</button>
    );
    /** The most relevant actions as buttons, the others behind a menu. */
    const actions = (list: string[], shown: number) => list.length <= shown + 1 ? list.map(a => button(a)) : [
        ...list.slice(0, shown).map(a => button(a)),
        <details key="more" className="mock-more" onClick={event => event.stopPropagation()}>
            <summary className="mock-button">{list.length - shown} more</summary>
            <div>{list.slice(shown).map(a => button(a))}</div>
        </details>
    ];
    const part = (p: ScreenPart, i: number) => {
        const of = p.query ?? p.projection ?? p.submits!;
        const title = (
            <button className={`mock-card-title${mark(of)}`} title={[p.query && `query ${p.query}`, p.projection && `projection ${p.projection}`, p.submits && `action ${p.submits}`].filter(Boolean).join(' as ')} onClick={() => onSelect(of)}>
                {human(of.split('.').at(-1)!)}
            </button>
        );
        if (p.kind === 'list') return (
            <section key={i} className="mock-card" style={next()}>
                <header>{title}<span className="mock-search" aria-hidden="true">Search</span></header>
                <table className="mock-table">
                    <thead><tr>{p.fields.map(f => <th key={f}>{human(f)}</th>)}{p.actions.length > 0 && <th />}{p.opens && <th />}</tr></thead>
                    <tbody>
                        {[0, 1, 2, 3].map(row => (
                            <tr key={row} style={{ '--r': row } as CSSProperties} className={p.opens ? 'opens' : undefined} title={p.opens ? `opens ${p.opens}` : undefined} onClick={() => p.opens && go(p.opens)}>
                                {p.fields.map((f, c) => <td key={f}><span className="mock-bar" style={{ width: `${45 + ((row * 3 + c * 5) % 6) * 9}%` }} /></td>)}
                                {p.actions.length > 0 && <td className="mock-row-actions">{actions(p.actions, 2)}</td>}
                                {p.opens && <td className="mock-chevron" aria-hidden="true">›</td>}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>
        );
        if (p.kind === 'detail') return (
            <section key={i} className="mock-card" style={next()}>
                <header>{title}<span className="mock-actions">{actions(p.actions, 3)}</span></header>
                <dl className="mock-fields">
                    {p.fields.map((f, c) => <div key={f}><dt>{human(f)}</dt><dd><span className="mock-bar" style={{ width: `${40 + (c * 7 % 5) * 12}%` }} /></dd></div>)}
                </dl>
            </section>
        );
        return (
            <section key={i} className="mock-card" style={next()}>
                <header>{title}</header>
                <div className="mock-form">
                    {p.fields.map(f => <label key={f}>{human(f)}<span className="mock-input" /></label>)}
                    <div className="mock-actions">{button(p.submits!, true)}</div>
                </div>
            </section>
        );
    };
    return (
        <main className="mock-page" style={{ '--start': `${start}ms` } as CSSProperties}>
            {screen.flows.map(f => (
                <div key={f.flow} className="mock-stepper" style={next()} title={`flow ${f.flow}`}>
                    <strong>{human(f.label)}</strong>
                    <span>Step {f.step} of {f.of}</span>
                    <span className="mock-steps" aria-hidden="true">{Array.from({ length: f.of }, (_, i) => <i key={i} className={i < f.step ? 'done' : undefined} />)}</span>
                </div>
            ))}
            <div className="mock-heading" style={next()}>
                <h1><button className={mark(screen.qn).trim()} title={`page ${screen.qn}`} onClick={() => onSelect(screen.qn)}>{human(screen.label)}</button></h1>
                {screen.shows && <p>{screen.shows}</p>}
            </div>
            {screen.parts.map(part)}
            {screen.flows.filter(f => f.next).map(f => (
                <footer key={f.flow} className="mock-footer" style={next()}>
                    <button className="mock-button primary" onClick={() => go(f.next!)}>Continue to {human(f.next!.split('.').at(-1)!)} →</button>
                </footer>
            ))}
        </main>
    );
}

/** The place of an element in a cascade, for its delay. */
function order(i: number): CSSProperties {
    return { '--i': i } as CSSProperties;
}

function pagesOf(item: MenuItem): string[] {
    return item.children.flatMap(child => [child.page, ...pagesOf(child)]);
}

/** A name as an application shows it: `OrderDetail` as `Order detail`, `created_at` as `Created at`. */
function human(name: string): string {
    const words = name.replace(/[_-]+/g, ' ').replace(/(?<=[a-z0-9])([A-Z])/g, ' $1').trim().toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

function initials(qn: string): string {
    return human(qn.split('.').at(-1)!).split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

/** A route with sample values for its parameters, as a browser would show it. */
function sampleRoute(route: string): string {
    return route.replace(/\{[^}]+\}/g, '1042');
}
