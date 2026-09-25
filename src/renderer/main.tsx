import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { useUi } from './store/ui';
import { TrayGlance } from './tray/TrayGlance';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

// The tray popover loads this same bundle; the hash is the whole router.
const glance = window.location.hash === '#tray';

// Open Office / Open Canvas in the tray reach the window here.
window.atrium.window.onMode((mode) => useUi.getState().setMode(mode));

createRoot(container).render(<StrictMode>{glance ? <TrayGlance /> : <App />}</StrictMode>);
