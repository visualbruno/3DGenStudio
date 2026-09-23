// Copies an existing SQLite database into a fresh PostgreSQL one.
//
// Only DB ROWS move. Asset bytes stay exactly where they are — images, meshes,
// thumbnails and motion clips live on disk under data/assets and are referenced
// by path, so the filesystem is untouched and needs no migration of its own.
//
//   node tools/migrate-sqlite-to-postgres.mjs \
//     --from ./data/app.db \
//     --to postgres://genstudio:secret@localhost:5432/genstudio
//
// Or, for the PostgreSQL the app manages itself (see pgEmbedded.js) — which
// saves finding the generated password:
//
//   node tools/migrate-sqlite-to-postgres.mjs --from ./data/app.db --to embedded
//
// Options:
//   --force    overwrite a target that already holds rows (it is TRUNCATEd)
//   --dry-run  read and count everything, write nothing
//
// The whole copy runs in ONE transaction: either the new database is complete or
// it is untouched. A half-migrated server is the one outcome worth ruling out.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import sqlite3 from 'sqlite3';

// Where the code lives — used only to read db/schema.pg.sql, which ships with it.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Where the DATA lives, which is a different question. storage.js derives
// DATA_DIR from process.cwd() and every deployment relies on that: the Docker
// image sets WORKDIR, and the desktop shell spawns the backend with cwd set to
// the per-user data directory. Resolving against the code directory instead
// would migrate into, or provision a database inside, the checkout — which is
// exactly the mistake this comment exists to stop the next person repeating.
const DATA_DIR = path.join(process.cwd(), 'data');

function parseArgs(argv) {
  const args = { force: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from') args.from = argv[++i];
    else if (arg === '--to') args.to = argv[++i];
    else if (arg === '--force') args.force = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const sourceFile = path.resolve(process.cwd(), args.from ?? path.join(DATA_DIR, 'app.db'));

// `--to embedded` targets the PostgreSQL that 3D Gen Studio manages itself,
// starting or adopting it as needed. Without this the operator would have to dig
// the generated password out of data/pg-credentials.json and paste a URL, which
// is a poor way to begin a migration.
let embedded = null;
if (args.to === 'embedded') {
  embedded = await import('../pgEmbedded.js');
  if (!embedded.isAvailableHere()) {
    console.error(embedded.unavailableReason());
    process.exit(1);
  }
  args.to = await embedded.start({
    dataRoot: DATA_DIR,
    onStatus: message => console.log(`🐘 ${message}`)
  });
}

const targetUrl = args.to ?? process.env.GENSTUDIO_DATABASE_URL;

if (!targetUrl) {
  console.error('A target is required: pass --to <postgres url> or set GENSTUDIO_DATABASE_URL.');
  process.exit(1);
}
if (!fs.existsSync(sourceFile)) {
  console.error(`Source database not found: ${sourceFile}`);
  process.exit(1);
}

// int8 arrives as a string by default, and every id and timestamp in this schema
// is one. Same parser the app installs, for the same reason.
pg.types.setTypeParser(pg.types.builtins.INT8, value => (value === null ? null : Number(value)));

// ---------------------------------------------------------------------------
// SQLite side
// ---------------------------------------------------------------------------
const sqlite = new sqlite3.Database(sourceFile, sqlite3.OPEN_READONLY);
const sqliteAll = (sql, params = []) =>
  new Promise((resolve, reject) => sqlite.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

// ---------------------------------------------------------------------------
// Table order comes from the generated schema, which is already sorted so that
// no table is created before one it references. The same order is safe to insert
// in, and keeping one source for it means the two cannot disagree.
// ---------------------------------------------------------------------------
const schemaSql = fs.readFileSync(path.join(ROOT, 'db', 'schema.pg.sql'), 'utf8');
const TABLE_ORDER = [...schemaSql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]);
if (!TABLE_ORDER.length) {
  console.error('Could not read the table order out of db/schema.pg.sql.');
  process.exit(1);
}

// Table names are interpolated straight into SQL below (Postgres has no way to
// bind an identifier as a parameter), so every one is checked against a strict
// allow-list pattern here, once, before any query can use it.
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
for (const table of TABLE_ORDER) {
  if (!SAFE_IDENTIFIER.test(table)) {
    console.error(`Refusing to use unsafe table name from schema.pg.sql: ${table}`);
    process.exit(1);
  }
}

// PostgreSQL caps a statement at 65535 bound parameters. Staying well under it
// keeps the batch size honest for a wide table like Assets.
const MAX_PARAMS_PER_STATEMENT = 20000;

async function main() {
  const client = new pg.Client({ connectionString: targetUrl });
  await client.connect();

  try {
    // The schema has to exist first. Applying it here rather than demanding the
    // server has already booted once keeps this a single step.
    await client.query(schemaSql);

    const liveTables = new Set(
      (await client.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`
      )).rows.map(r => r.table_name)
    );

    // Reference data, seeded by storage.js on every start. Their presence says
    // nothing about whether real data is here, so they must not be what makes
    // this refuse — a server that merely booted once against the empty database
    // would otherwise lock the migration out of it.
    const SEEDED = new Set(['columns', 'nodetypes', 'assettypes', 'attributes', 'settings']);

    const blocking = [];
    let anyRows = false;
    for (const table of TABLE_ORDER) {
      const { rows } = await client.query(`SELECT COUNT(*) AS n FROM ${table}`);
      const count = Number(rows[0].n);
      if (count === 0) continue;
      anyRows = true;
      if (!SEEDED.has(table.toLowerCase())) blocking.push(`${table} (${count})`);
    }

    if (blocking.length && !args.force) {
      console.error('The target database already holds data:\n  ' + blocking.join('\n  '));
      console.error('\nRefusing to merge into it. Re-run with --force to TRUNCATE and replace.');
      process.exit(1);
    }

    const sourceTables = new Set(
      (await sqliteAll("SELECT name FROM sqlite_master WHERE type='table'")).map(r => r.name)
    );

    console.log(`source: ${sourceFile}`);
    console.log(`target: ${targetUrl.replace(/:[^:@/]*@/, ':***@')}`);
    if (args.dryRun) console.log('DRY RUN — nothing will be written\n');
    else console.log('');

    await client.query('BEGIN');

    // Foreign keys are DEFERRABLE precisely so this works: a self-referencing
    // table (Assets.parentId, WikiPages.parentId) can be loaded in one shot
    // without first working out a parents-before-children ordering.
    await client.query('SET CONSTRAINTS ALL DEFERRED');

    if (anyRows) {
      // Reverse order so a table is emptied before whatever it depends on.
      // CASCADE would work too, but naming them all keeps the blast radius
      // exactly the tables this tool owns. This runs for seeded reference rows
      // as well: leaving those in place would collide with the ones coming from
      // the source database, which carries its own copies.
      await client.query(`TRUNCATE ${[...TABLE_ORDER].reverse().join(', ')}`);
      console.log(`cleared ${TABLE_ORDER.length} tables in the target\n`);
    }

    const counts = [];

    for (const table of TABLE_ORDER) {
      if (!liveTables.has(table.toLowerCase())) {
        console.log(`${table.padEnd(18)} skipped — not in the PostgreSQL schema`);
        continue;
      }
      if (!sourceTables.has(table)) {
        console.log(`${table.padEnd(18)} skipped — not in the SQLite database`);
        continue;
      }

      // Columns come from the SOURCE, so a column the old database never gained
      // is simply left at its default rather than inserted as undefined.
      const sourceColumns = (await sqliteAll(`PRAGMA table_info(${table})`)).map(c => c.name);
      const targetColumns = new Set(
        (await client.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = $1`,
          [table.toLowerCase()]
        )).rows.map(r => r.column_name)
      );
      const columns = sourceColumns.filter(c => targetColumns.has(c.toLowerCase()));

      const dropped = sourceColumns.filter(c => !targetColumns.has(c.toLowerCase()));
      if (dropped.length) {
        console.log(`${table.padEnd(18)} NOTE: source columns absent from the target: ${dropped.join(', ')}`);
      }

      const rows = await sqliteAll(`SELECT ${columns.join(', ')} FROM ${table}`);
      if (!rows.length) {
        console.log(`${table.padEnd(18)} 0`);
        counts.push([table, 0]);
        continue;
      }

      const perRow = columns.length;
      const batchSize = Math.max(1, Math.floor(MAX_PARAMS_PER_STATEMENT / perRow));

      if (!args.dryRun) {
        for (let start = 0; start < rows.length; start += batchSize) {
          const batch = rows.slice(start, start + batchSize);
          const values = [];
          const tuples = batch.map((row, rowIndex) => {
            const placeholders = columns.map((column, columnIndex) => {
              values.push(row[column]);
              return `$${rowIndex * perRow + columnIndex + 1}`;
            });
            return `(${placeholders.join(', ')})`;
          });
          await client.query(
            `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`,
            values
          );
        }
      }

      console.log(`${table.padEnd(18)} ${rows.length}`);
      counts.push([table, rows.length]);
    }

    // Identity columns keep their own sequence, and inserting explicit ids does
    // not advance it. Skipping this is the classic way a migration "succeeds"
    // and then fails on the very first row anyone creates afterwards.
    if (!args.dryRun) {
      const identities = await client.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND is_identity = 'YES'`
      );
      for (const { table_name: table, column_name: column } of identities.rows) {
        await client.query(
          `SELECT setval(
             pg_get_serial_sequence($1, $2),
             COALESCE((SELECT MAX(${column}) FROM ${table}), 0) + 1,
             false
           )`,
          [table, column]
        );
      }
      console.log(`\nreset ${identities.rows.length} identity sequences`);
    }

    if (args.dryRun) {
      await client.query('ROLLBACK');
      console.log('\ndry run complete — rolled back');
    } else {
      await client.query('COMMIT');

      // Verify against the committed data rather than trusting the inserts.
      let mismatch = 0;
      for (const [table, expected] of counts) {
        const { rows } = await client.query(`SELECT COUNT(*) AS n FROM ${table}`);
        const actual = Number(rows[0].n);
        if (actual !== expected) {
          console.error(`MISMATCH ${table}: expected ${expected}, found ${actual}`);
          mismatch += 1;
        }
      }
      if (mismatch) {
        console.error(`\n${mismatch} table(s) did not match. The data is committed — investigate before using it.`);
        process.exit(1);
      }

      const total = counts.reduce((sum, [, n]) => sum + n, 0);
      console.log(`\nmigrated ${total} rows across ${counts.length} tables, all counts verified`);
      console.log('\nAsset files were not touched: they stay on disk under data/assets.');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nMigration failed, nothing was written:');
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
    sqlite.close();
    // Leave the machine as it was found: a migration should not silently become
    // the thing that started a database server.
    if (embedded) await embedded.stop();
  }
}

await main();
