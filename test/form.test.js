import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCatalog, syncSemanticForm } from "../src/index.js";

const initialCatalog = {
  engine: "sqlite",
  databaseName: "main",
  schemaVersion: 1,
  objects: [{
    name: "notes",
    kind: "table",
    definition: "CREATE TABLE notes (note_id INTEGER PRIMARY KEY, body TEXT)",
    comment: "Stores notes.",
    columns: [
      { name: "note_id", ordinal: 0, type: "INTEGER", nullable: true, primaryKeyPosition: 1, comment: "Note identity." },
      { name: "body", ordinal: 1, type: "TEXT", nullable: true, primaryKeyPosition: 0, comment: "Complete note text." },
    ],
    relationships: [],
    indexes: [],
  }],
};

test("one form seeds comments once and preserves human semantics during synchronization", () => {
  const initialized = syncSemanticForm({ catalog: initialCatalog, seedComments: true, now: new Date("2026-01-01T00:00:00Z") });
  assert.equal(initialized.form.objects.notes.semantics.purpose, "Stores notes.");
  assert.equal(initialized.form.objects.notes.semantics.rowMeaning, "Stores notes.");
  assert.equal(initialized.form.objects.notes.fields.body.semantics.meaning, "Complete note text.");

  initialized.form.objects.notes.semantics.rowMeaning = "One durable user note.";
  initialized.form.objects.notes.fields.body.semantics.meaning = "Canonical content interpreted by the agent.";

  const changedCatalog = structuredClone(initialCatalog);
  changedCatalog.schemaVersion = 2;
  changedCatalog.objects[0].comment = null;
  changedCatalog.objects[0].columns = [
    changedCatalog.objects[0].columns[0],
    { name: "status", ordinal: 1, type: "TEXT", nullable: false, primaryKeyPosition: 0, comment: "Ignored during ordinary sync." },
  ];
  const synchronized = syncSemanticForm({
    catalog: changedCatalog,
    existingForm: initialized.form,
    seedComments: false,
    now: new Date("2026-01-02T00:00:00Z"),
  });

  assert.equal(synchronized.form.objects.notes.semantics.rowMeaning, "One durable user note.");
  assert.equal(synchronized.form.objects.notes.fields.body.mechanics.present, false);
  assert.equal(
    synchronized.form.objects.notes.fields.body.semantics.meaning,
    "Canonical content interpreted by the agent.",
  );
  assert.equal(synchronized.form.objects.notes.fields.status.semantics.meaning, null);
  assert.deepEqual(synchronized.report.addedFields, ["notes.status"]);
  assert.deepEqual(synchronized.report.removedFields, ["notes.body"]);
});

test("schema fingerprint ignores comments because the JSON form owns semantics", () => {
  const withComments = normalizeCatalog(initialCatalog);
  const withoutCommentsCatalog = structuredClone(initialCatalog);
  withoutCommentsCatalog.objects[0].comment = null;
  withoutCommentsCatalog.objects[0].columns.forEach((column) => { column.comment = null; });
  const withoutComments = normalizeCatalog(withoutCommentsCatalog);
  assert.equal(withComments.fingerprint, withoutComments.fingerprint);
});
