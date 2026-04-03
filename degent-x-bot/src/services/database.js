const { drizzle } = require('drizzle-orm/postgres-js');
const postgres = require('postgres');
const config = require('../config');
const schema = require('../db/schema');
const logger = require('../lib/logger');

let db = null;
let sql = null;

function getDb() {
  if (!db) {
    sql = postgres(config.databaseUrl, { max: 10 });
    db = drizzle(sql, { schema });
    logger.info('Database connection established');
  }
  return db;
}

async function closeDb() {
  if (sql) {
    await sql.end();
    db = null;
    sql = null;
    logger.info('Database connection closed');
  }
}

module.exports = { getDb, closeDb };
