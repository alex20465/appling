import { createRoot } from 'react-dom/client';
import '@appling/viz/canvas.css';
import { App } from './App.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
