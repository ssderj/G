import React from 'react';
import { InkRoot } from './ink-root.jsx';
import { NavigationProvider } from './nav-context.jsx';


// The original file's own mount call (`ReactDOM.createRoot(...).render(...)`) has been removed
// — main.jsx owns mounting now (via App.jsx, which re-exports this file's default export). This
// is no longer a pending step — main.jsx already imports and mounts it, wrapped in its own
// AppErrorBoundary/SyncProvider/SyncGate — so the "TODO comment there" this used to point at no
// longer exists in main.jsx; left only as a note in case this stale line is read in isolation.
//
// SyncStatusIndicator used to mount here, one level above NavigationProvider/InkRoot, so it
// stayed mounted and floating over every screen in the app. It's rendered by HomeScreen itself
// now (see home-screen.jsx), Home-only, so it no longer needs a seat at this top level.
export default function InkrootApp() {
    return React.createElement(NavigationProvider, { rootLabel: 'Home' }, React.createElement(InkRoot, null));
}
