import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Story } from '../stories.js';
import { DEFAULT_VIEW, flowView, lensOf, screenFlow, useCaseDiagram, type GraphIndex, type UseCaseDiagram, type ViewSettings } from '../views.js';
import { FlowCanvas } from './FlowCanvas.js';
import { ModelCanvas } from './ModelCanvas.js';
import { ScreenCanvas } from './ScreenCanvas.js';
import { UseCaseCanvas } from './UseCaseCanvas.js';

/** A story: one view, started from its element, as interactive as in the inspector. */
export function StoryCanvas({ story, index, name }: { story: Pick<Story, 'view' | 'element'>, index: GraphIndex, name: string }) {
    const [selected, setSelected] = useState<string>();
    const [settings, setSettings] = useState<ViewSettings>(() => ({ ...DEFAULT_VIEW, lens: lensOf(index.nodes.get(story.element)?.kind ?? '') ?? DEFAULT_VIEW.lens }));
    const [actor, setActor] = useState(story.element);
    const focus = useMemo(() => [story.element], [story.element]);
    const flow = useMemo(() => story.view === 'states' ? flowView(index, 'machine', focus) : undefined, [index, story.view, focus]);
    const diagram = useMemo(() => story.view === 'usecases' ? startedBy(useCaseDiagram(index), story.element) : undefined, [index, story.view, story.element]);
    const screens = useMemo(() => story.view === 'screens' ? screenFlow(index, actor) : undefined, [index, story.view, actor]);
    const view = useRef<HTMLDivElement>(null);
    // a diagram scales down to fit the story's box instead of scrolling in it
    useLayoutEffect(() => {
        const box = view.current;
        const board = box?.querySelector<HTMLElement | SVGSVGElement>('.flow > :first-child');
        if (!box || !board) return;
        // the board's own size, from its width and height, which zoom does not change
        const [width, height] = [parseFloat(board.style.width || board.getAttribute('width')!), parseFloat(board.style.height || board.getAttribute('height')!)];
        const fit = () => { board.style.zoom = String(Math.min(1, (box.clientWidth - 32) / width, (box.clientHeight - 32) / height)); };
        const observer = new ResizeObserver(fit);
        observer.observe(box);
        return () => observer.disconnect();
    }, [flow, diagram]);
    return (
        <div ref={view} className="story-view">
            {flow ? <FlowCanvas index={index} flow={flow} selected={selected} states onSelect={setSelected} />
                : diagram ? <UseCaseCanvas diagram={diagram} name={name} selected={selected} onSelect={setSelected} />
                : screens ? <ScreenCanvas key={actor} flow={screens} name={name} actor={actor} actors={[story.element]} selected={selected} onActor={setActor} onSelect={setSelected} />
                : <ModelCanvas index={index} name={name} focus={focus} selected={selected} settings={settings} onSelect={setSelected} onSettings={setSettings} />}
        </div>
    );
}

/** The part of a use case diagram one actor starts: its use cases and what they include. */
function startedBy(diagram: UseCaseDiagram, actor: string): UseCaseDiagram {
    const associations = diagram.associations.filter(a => a.actor === actor);
    const reached = new Set(associations.map(a => a.useCase));
    for (let size = 0; size !== reached.size;) {
        size = reached.size;
        for (const include of diagram.includes) if (reached.has(include.from)) reached.add(include.to);
    }
    return {
        actors: diagram.actors.filter(a => a.qn === actor),
        useCases: diagram.useCases.filter(u => reached.has(u.qn)),
        associations,
        includes: diagram.includes.filter(i => reached.has(i.from))
    };
}
