import { useMemo, useState, type ReactNode } from 'react';
import { FlowCanvas, qualifiedOptions, ScreenCanvas, Select, UseCaseCanvas } from '@appling/viz/canvas';
import { byRelevance, flowView, screenFlow, useCaseDiagram, type GraphIndex, type ModelView } from '@appling/viz/views';

/** The views of the model in the order of the rail, each with the question it answers; a new view is one more entry. */
export const MODEL_VIEWS: { id: ModelView, label: string, question: string, icon: string }[] = [
    { id: 'levels', label: 'Levels', question: 'What rests on what?', icon: 'pyramid' },
    { id: 'usecases', label: 'Use cases', question: 'Who does what?', icon: 'person-standing' },
    { id: 'states', label: 'States', question: 'How does it change?', icon: 'waypoints' },
    { id: 'screens', label: 'Screens', question: 'What does it look like?', icon: 'app-window' }
];

interface DiagramProps {
    index: GraphIndex;
    name: string;
    icons?: Record<string, string>;
    selected?: string;
    onSelect(qn: string): void;
}

/** One of the views beside the level canvas. */
export function Diagram({ view, ...props }: DiagramProps & { view: Exclude<ModelView, 'levels'> }) {
    const View = { usecases: UseCases, states: States, screens: Screens }[view];
    return <div className="diagrams"><View {...props} /></div>;
}

/** What a view shows when the model has nothing for it: the declarations that would fill it. */
function Empty({ children }: { children: ReactNode }) {
    return <p className="diagram-empty">{children}</p>;
}

function UseCases({ index, name, icons, selected, onSelect }: DiagramProps) {
    const diagram = useMemo(() => useCaseDiagram(index), [index]);
    if (!diagram.useCases.length) return <Empty>No use cases yet. Declare a <code>usecase</code>, and an <code>actor</code> whose role one of its policies names, to draw them.</Empty>;
    return <UseCaseCanvas diagram={diagram} name={name} icons={icons} selected={selected} onSelect={onSelect} />;
}

function States({ index, selected, onSelect }: DiagramProps) {
    const machines = useMemo(() => byRelevance(index, 'Machine'), [index]);
    const [picked, setPicked] = useState<string>();
    const machine = machines.find(m => m.qn === picked) ?? machines[0];
    const flow = useMemo(() => machine && flowView(index, 'machine', [machine.qn]), [index, machine]);
    if (!machine || !flow) return <Empty>No state machines yet. Declare a <code>machine</code> on a state field of an entity to draw its states.</Empty>;
    return (
        <>
            <Picker label="Machine" value={machine.qn} options={machines.map(m => m.qn)} onChange={setPicked} />
            <FlowCanvas index={index} flow={flow} selected={selected} states onSelect={onSelect} />
        </>
    );
}

function Screens({ index, name, selected, onSelect }: DiagramProps) {
    const actors = useMemo(() => byRelevance(index, 'Actor'), [index]);
    const [picked, setPicked] = useState<string>();
    const actor = actors.find(a => a.qn === picked) ?? actors[0];
    const flow = useMemo(() => actor && screenFlow(index, actor.qn), [index, actor]);
    if (!actor || !flow) return <Empty>No actors yet. Declare an <code>actor</code> to see the screens it reaches.</Empty>;
    if (!flow.screens.length) return (
        <>
            <Picker label="Actor" value={actor.qn} options={actors.map(a => a.qn)} onChange={setPicked} />
            <Empty>{actor.qn} reaches no screen. Declare a <code>page</code> whose queries or actions its policies allow, and a <code>navigation</code> that leads to it.</Empty>
        </>
    );
    return <ScreenCanvas key={actor.qn} flow={flow} name={name} actor={actor.qn} actors={actors.map(a => a.qn)} selected={selected} onActor={setPicked} onSelect={onSelect} />;
}

/** A chip over the top left of the view that picks what it draws. */
function Picker({ label, value, options, onChange }: { label: string, value: string, options: string[], onChange(value: string): void }) {
    return <Select className="diagram-picker" value={value} options={qualifiedOptions(options)} label={label} showLabel onChange={onChange} />;
}
