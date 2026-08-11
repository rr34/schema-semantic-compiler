import assert from "node:assert/strict";
import test from "node:test";
import { extractMariaDbCatalog } from "../src/adapters/mariadb.js";

test("MariaDB adapter normalizes information_schema into the shared catalog", async () => {
  const query = async (sql) => {
    if (sql.includes("information_schema.TABLES")) return [[
      { TABLE_NAME: "contacts", TABLE_TYPE: "BASE TABLE", ENGINE: "InnoDB", TABLE_COMMENT: "Known people." },
      { TABLE_NAME: "notes", TABLE_TYPE: "BASE TABLE", ENGINE: "InnoDB", TABLE_COMMENT: "Durable notes." },
    ], []];
    if (sql.includes("information_schema.COLUMNS")) return [[
      { TABLE_NAME: "contacts", COLUMN_NAME: "contact_id", ORDINAL_POSITION: 1, COLUMN_DEFAULT: null, IS_NULLABLE: "NO", DATA_TYPE: "int", COLUMN_TYPE: "int(11)", COLUMN_KEY: "PRI", EXTRA: "auto_increment", COLUMN_COMMENT: "Contact identity.", GENERATION_EXPRESSION: "" },
      { TABLE_NAME: "notes", COLUMN_NAME: "note_id", ORDINAL_POSITION: 1, COLUMN_DEFAULT: null, IS_NULLABLE: "NO", DATA_TYPE: "int", COLUMN_TYPE: "int(11)", COLUMN_KEY: "PRI", EXTRA: "auto_increment", COLUMN_COMMENT: "", GENERATION_EXPRESSION: "" },
      { TABLE_NAME: "notes", COLUMN_NAME: "contact_id", ORDINAL_POSITION: 2, COLUMN_DEFAULT: null, IS_NULLABLE: "YES", DATA_TYPE: "int", COLUMN_TYPE: "int(11)", COLUMN_KEY: "MUL", EXTRA: "", COLUMN_COMMENT: "Related contact.", GENERATION_EXPRESSION: "" },
      { TABLE_NAME: "notes", COLUMN_NAME: "status", ORDINAL_POSITION: 3, COLUMN_DEFAULT: "active", IS_NULLABLE: "NO", DATA_TYPE: "enum", COLUMN_TYPE: "enum('active','archived')", COLUMN_KEY: "", EXTRA: "", COLUMN_COMMENT: "Lifecycle status.", GENERATION_EXPRESSION: "" },
    ], []];
    if (sql.includes("information_schema.KEY_COLUMN_USAGE")) return [[
      { CONSTRAINT_NAME: "notes_contact_fk", TABLE_NAME: "notes", COLUMN_NAME: "contact_id", ORDINAL_POSITION: 1, REFERENCED_TABLE_NAME: "contacts", REFERENCED_COLUMN_NAME: "contact_id", UPDATE_RULE: "CASCADE", DELETE_RULE: "SET NULL" },
    ], []];
    if (sql.includes("information_schema.STATISTICS")) return [[
      { TABLE_NAME: "contacts", INDEX_NAME: "PRIMARY", NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: "contact_id", INDEX_TYPE: "BTREE" },
      { TABLE_NAME: "notes", INDEX_NAME: "PRIMARY", NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: "note_id", INDEX_TYPE: "BTREE" },
      { TABLE_NAME: "notes", INDEX_NAME: "notes_contact_fk", NON_UNIQUE: 1, SEQ_IN_INDEX: 1, COLUMN_NAME: "contact_id", INDEX_TYPE: "BTREE" },
    ], []];
    if (sql.includes("information_schema.VIEWS")) return [[], []];
    throw new Error(`Unexpected query: ${sql}`);
  };

  const catalog = await extractMariaDbCatalog({ query, databaseName: "tlom", schemaVersion: 9 });
  assert.equal(catalog.engine, "mariadb");
  assert.equal(catalog.objects.length, 2);
  const notes = catalog.objects.find((object) => object.name === "notes");
  assert.equal(notes.comment, "Durable notes.");
  assert.deepEqual(notes.columns.find((column) => column.name === "status").allowedValues, ["active", "archived"]);
  assert.equal(notes.columns.find((column) => column.name === "note_id").primaryKeyPosition, 1);
  assert.equal(notes.relationships[0].id, "fk:notes_contact_fk");
  assert.equal(notes.relationships[0].targetObject, "contacts");
});
