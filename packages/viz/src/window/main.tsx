import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import '../canvas/canvas.css';
import { Window } from './Window.js';
import './window.css';

createRoot(document.getElementById('root')!).render(<Window />);
