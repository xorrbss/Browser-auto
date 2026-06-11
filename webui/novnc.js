// webui/novnc.js - deterministic noVNC session metadata and fail-closed authorization.
//
// This module does not start, proxy, or connect to noVNC. It only models
// tenant/job-scoped sessions and decides whether a request may reach a future
// authenticated proxy boundary.
//
// Facade: implementation lives in novnc-shared.js, novnc-isolation.js,
// novnc-sessions.js, and novnc-access.js.

export { generateNoVncSessionId } from './novnc-shared.js';
export {
	buildNoVncTeardownManifest,
	deriveNoVncBrowserPaths,
	isNoVncProductionMode,
	validateNoVncExternalBoundary,
	validateNoVncIsolationPreflight,
	validateNoVncRegistryIsolation,
	validateNoVncTeardownManifest,
} from './novnc-isolation.js';
export {
	createNoVncSessionRecord,
	createNoVncSessionRegistry,
	noVncSessionExpired,
	noVncSessionExpiry,
	publicNoVncSession,
} from './novnc-sessions.js';
export {
	authorizeNoVncAccess,
	authorizeNoVncRoute,
	isNoVncRoutePath,
	noVncRegistryFromEnv,
	parseNoVncRoute,
} from './novnc-access.js';
