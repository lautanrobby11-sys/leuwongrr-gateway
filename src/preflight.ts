import { loadConfig } from './config.js';
import { GatewayDatabase } from './persistence/database.js';
import { verifyDatabasePreflight } from './persistence/preflight-check.js';

const config = loadConfig();
const db = new GatewayDatabase(config.DATABASE_PATH, config.API_KEY_PEPPER);
try {
  verifyDatabasePreflight(db);
  console.log('preflight passed');
} finally {
  db.close();
}
