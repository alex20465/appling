import { createRoot } from 'react-dom/client';
import '../canvas/canvas.css';
import { Window } from './Window.js';
import './window.css';

createRoot(document.getElementById('root')!).render(<Window />);
