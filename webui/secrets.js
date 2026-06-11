// webui/secrets.js - facade over the secret subsystem (core/policy/stores/boundary/
// migration modules). Re-exports the full public surface so consumer imports stay stable.

export {
	makeSecretRef,
	parseSecretRef,
} from './secrets-core.js';
export {
	secretRuntimePolicy,
	secretBackendSecureOnly,
	secretBackendPlaintextBlocked,
	secretBackendConfigBlockedReason,
	assertSecretBackendConfigured,
	validateSecretBrokerAdapter,
} from './secrets-policy.js';
export { LocalPilotSecretStore } from './secrets-store-local.js';
export { EncryptedLocalSecretStore } from './secrets-store-encrypted.js';
export {
	createSecretStore,
	ExternalBrokerSecretStore,
	FakeExternalSecretBroker,
	createFakeSecretBrokerForTests,
} from './secrets-store-broker.js';
export {
	classifySecretPath,
	isSecretBearingPath,
	staticFilePolicy,
	scanExportBundle,
	assertExportBundleAllowed,
} from './secrets-boundary.js';
export {
	inventoryPlaintextSecretMigration,
	planPlaintextSecretMigration,
	buildSecretMigrationApprovalManifest,
	validateSecretMigrationApprovalManifest,
} from './secrets-migration.js';
export { productionSecretMigrationExecutionContract } from './secrets-migration-production.js';
