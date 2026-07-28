import { loadConfig } from './config.js';
import { GatewayDatabase } from './persistence/database.js';
const config=loadConfig(); const db=new GatewayDatabase(config.DATABASE_PATH,config.API_KEY_PEPPER); const result=db.db.pragma('integrity_check') as Array<{integrity_check:string}>; if(result[0]?.integrity_check!=='ok') throw new Error('database_integrity_failed'); db.close(); console.log('preflight passed');
