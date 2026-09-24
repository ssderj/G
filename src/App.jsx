import './app.css';
import InkrootApp from './shell/inkroot-app.jsx';

// Older browsers and some embedded WebViews don't have structuredClone
// (it only shipped widely in 2022) — without this, every edit in the app
// would throw immediately. All our data is plain JSON, so this fallback is safe.
if (typeof structuredClone !== 'function') {
    window.structuredClone = (obj) => JSON.parse(JSON.stringify(obj));
}

export default InkrootApp;
