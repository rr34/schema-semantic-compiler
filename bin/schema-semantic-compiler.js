#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { extractMariaDbCatalog } from "../src/adapters/mariadb.js";
import { extractSqliteCatalogFromFile } from "../src/adapters/sqlite.js";
import { compileSchemaProjection, inspectSemanticForm, syncSemanticForm } from "../src/index.js";

function usage() {
  return `Schema Semantic Compiler

Read-and-explain-only database schema context compiler.

Commands:
  init     Extract mechanics and create one semantic JSON form.
  sync     Refresh mechanics in an existing form while preserving semantics.
  project  Compile an operation-specific schema projection.
  check    Report blank semantic fields and retired schema objects.

SQLite examples:
  ssc init --engine sqlite --database ./data/app.sqlite --form ./db/schema-semantics.json
  ssc sync --engine sqlite --database ./data/app.sqlite --form ./db/schema-semantics.json

MariaDB examples:
  MYSQL_HOST=localhost MYSQL_USER=app MYSQL_PASSWORD=... MYSQL_DATABASE=app \\
    ssc init --engine mariadb --database app --form ./db/schema-semantics.json

Projection examples:
  ssc project --form ./db/schema-semantics.json --sql-file ./query.sql
  ssc project --form ./db/schema-semantics.json --operation-file ./operation.json --output ./projection.json

Options:
  --seed-comments  Seed blank semantics from native comments during sync. Init seeds by default.
  --force          Permit init to replace an existing form.
  --output FILE    Write project output to a file instead of stdout.
`;
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2).replaceAll("-", "_");
    if (["force", "seed_comments"].includes(key)) {
      options[key] = true;
      continue;
    }
    if (index + 1 >= rest.length || rest[index + 1].startsWith("--")) {
      throw new Error(`Missing value for ${argument}.`);
    }
    options[key] = rest[index + 1];
    index += 1;
  }
  return { command, options };
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(path.resolve(filename), "utf8"));
}

function writeJson(filename, value) {
  const resolved = path.resolve(filename);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, resolved);
}

async function mariaDbConnection(options) {
  let mysql;
  try {
    mysql = await import("mysql2/promise");
  } catch (error) {
    throw new Error(`MariaDB CLI extraction requires the optional mysql2 package: ${error.message}`);
  }
  const databaseName = options.database || process.env.MYSQL_DATABASE;
  if (!databaseName) throw new Error("MariaDB extraction requires --database or MYSQL_DATABASE.");
  const pool = options.url || process.env.SSC_MARIADB_URL
    ? mysql.createPool(options.url || process.env.SSC_MARIADB_URL)
    : mysql.createPool({
        host: options.host || process.env.MYSQL_HOST || "localhost",
        port: Number(options.port || process.env.MYSQL_PORT || 3306),
        user: options.user || process.env.MYSQL_USER,
        password: options.password || process.env.MYSQL_PASSWORD,
        database: databaseName,
        connectionLimit: 2,
      });
  return { pool, databaseName };
}

async function extractCatalog(options, engine) {
  if (engine === "sqlite") {
    if (!options.database) throw new Error("SQLite extraction requires --database FILE.");
    return extractSqliteCatalogFromFile({
      filename: path.resolve(options.database),
      schemaVersion: options.schema_version ?? null,
    });
  }
  if (engine === "mariadb") {
    const { pool, databaseName } = await mariaDbConnection(options);
    try {
      return await extractMariaDbCatalog({
        query: pool.query.bind(pool),
        databaseName,
        schemaVersion: options.schema_version ?? null,
      });
    } finally {
      await pool.end();
    }
  }
  throw new Error(`Unsupported database engine: ${String(engine)}.`);
}

async function initialize(options) {
  if (!options.form) throw new Error("init requires --form FILE.");
  const resolved = path.resolve(options.form);
  if (fs.existsSync(resolved) && !options.force) throw new Error(`Semantic form already exists: ${resolved}. Use --force to replace it.`);
  const engine = options.engine;
  const catalog = await extractCatalog(options, engine);
  const { form, report } = syncSemanticForm({ catalog, seedComments: true });
  writeJson(resolved, form);
  return { command: "init", form: resolved, report };
}

async function synchronize(options) {
  if (!options.form) throw new Error("sync requires --form FILE.");
  const existingForm = readJson(options.form);
  const engine = options.engine || existingForm.database?.engine;
  const catalog = await extractCatalog(options, engine);
  const { form, report } = syncSemanticForm({
    catalog,
    existingForm,
    seedComments: options.seed_comments === true,
  });
  writeJson(options.form, form);
  return { command: "sync", form: path.resolve(options.form), report };
}

function project(options) {
  if (!options.form) throw new Error("project requires --form FILE.");
  if (options.sql && options.sql_file) throw new Error("Use either --sql or --sql-file, not both.");
  const sql = options.sql_file ? fs.readFileSync(path.resolve(options.sql_file), "utf8") : options.sql ?? null;
  const operation = options.operation_file ? readJson(options.operation_file) : null;
  const output = compileSchemaProjection({ form: readJson(options.form), sql, operation });
  if (options.output) {
    writeJson(options.output, output);
    return { command: "project", output: path.resolve(options.output), projectionId: output.projectionId };
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return null;
}

function check(options) {
  if (!options.form) throw new Error("check requires --form FILE.");
  return { command: "check", form: path.resolve(options.form), ...inspectSemanticForm(readJson(options.form)) };
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (!command || ["help", "--help", "-h"].includes(command)) {
    process.stdout.write(usage());
    return;
  }
  let result;
  if (command === "init") result = await initialize(options);
  else if (command === "sync") result = await synchronize(options);
  else if (command === "project") result = project(options);
  else if (command === "check") result = check(options);
  else throw new Error(`Unknown command: ${command}.\n\n${usage()}`);
  if (result) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
