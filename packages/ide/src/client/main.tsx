// first: the hooks of a host that embeds the IDE in an iframe must exist before App reads them
import './frame-host.js';
import { createRoot } from 'react-dom/client';
import '@appling/viz/canvas.css';
import { App } from './App.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
