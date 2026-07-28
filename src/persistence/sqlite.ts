import type Database from 'better-sqlite3';

/**
 * Shared handle type. Declared apart from the gateway database so persistence
 * collaborators can accept a handle without importing the database module.
 */
export type SqliteHandle = InstanceType<typeof Database>;
