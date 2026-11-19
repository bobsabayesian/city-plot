import '@fontsource/inter/latin-400.css';
import '@fontsource/source-serif-4/latin-400.css';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { PhoneDrop } from './ui/PhoneDrop';
import { dropTokenHere } from './drop';
import './ui/styles.css';

// a phone that scanned the QR code of a photo drop gets just the page for sending photos
const drop = dropTokenHere();
createRoot(document.getElementById('root')!).render(drop ? <PhoneDrop token={drop} /> : <App />);
