import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@appling/viz/canvas.css';
import { StoryCanvas } from '@appling/viz/canvas';
import { STORIES } from '@appling/viz/stories';
import { GraphIndex } from '@appling/viz/views';
import { loadSnapshot } from './api.js';
import type { Snapshot } from '../shared/snapshot.js';
import './styles.css';

/** Every story of `@appling/viz/stories` on the model of the examples, as the landing site embeds them; `#<id>` shows one. */
function Stories() {
    const [snapshot, setSnapshot] = useState<Snapshot>();
    const [only, setOnly] = useState(location.hash.slice(1));
    useEffect(() => { void loadSnapshot().then(setSnapshot); }, []);
    useEffect(() => {
        const update = () => setOnly(location.hash.slice(1));
        addEventListener('hashchange', update);
        return () => removeEventListener('hashchange', update);
    }, []);
    const index = useMemo(() => snapshot && new GraphIndex(snapshot.graph), [snapshot]);
    if (!index) return <div className="loading">Loading the model</div>;
    const shown = STORIES.filter(story => !only || story.id === only);
    return (
        <main className="stories">
            {shown.map(story => (
                <section key={story.id} id={story.id} className="story">
                    <header>
                        <a href={`#${story.id}`}><b>{story.title}</b> {story.question}</a>
                        <p>{story.text}</p>
                    </header>
                    <div className="story-canvas"><StoryCanvas story={story} index={index} name="examples" /></div>
                </section>
            ))}
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Stories />);
