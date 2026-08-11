import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { extractSqliteCatalogFromFile } from "../src/adapters/sqlite.js";
import { syncSemanticForm } from "../src/index.js";

test("SQLite adapter extracts mechanics, checks, relationships, and bootstrap comments", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ssc-sqlite-"));
  const filename = path.join(directory, "test.sqlite");
  const database = new DatabaseSync(filename);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE contacts (
      -- Stable contact identity.
      contact_id INTEGER PRIMARY KEY,
      display_name TEXT NOT NULL
    ) STRICT;
    CREATE TABLE notes (
      note_id INTEGER PRIMARY KEY,
      -- Person discussed by the note.
      contact_id INTEGER REFERENCES contacts(contact_id) ON DELETE SET NULL,
      -- Complete note content.
      body TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived'))
    ) STRICT;
    CREATE INDEX notes_status ON notes(status);
  `);
  database.close();

  try {
    const catalog = extractSqliteCatalogFromFile({ filename });
    const notes = catalog.objects.find((object) => object.name === "notes");
    assert.ok(notes);
    assert.deepEqual(notes.columns.find((column) => column.name === "status").allowedValues, ["active", "archived"]);
    assert.equal(notes.columns.find((column) => column.name === "body").comment, "Complete note content.");
    assert.equal(notes.relationships[0].targetObject, "contacts");
    assert.deepEqual(notes.indexes.find((index) => index.name === "notes_status").columns, ["status"]);

    const { form } = syncSemanticForm({ catalog, seedComments: true });
    assert.equal(form.objects.notes.fields.body.semantics.meaning, "Complete note content.");
    assert.equal(form.objects.notes.fields.status.semantics.meaning, null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
