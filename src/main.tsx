import '@fontsource/inter/latin-400.css';
import '@fontsource/source-serif-4/latin-400.css';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/styles.css';

createRoot(document.getElementById('root')!).render(<App />);
