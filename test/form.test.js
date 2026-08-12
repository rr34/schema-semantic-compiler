import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCatalog, syncSemanticForm, upgradeSemanticForm } from "../src/index.js";

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
  assert.equal(initialized.form.schemaObjects.notes.semantics.purpose, "Stores notes.");
  assert.equal(initialized.form.schemaObjects.notes.semantics.rowMeaning, "Stores notes.");
  assert.deepEqual(initialized.form.schemaObjects.notes.semantics.keywords, []);
  assert.equal(initialized.form.schemaObjects.notes.semantics.routingWeight, null);
  assert.equal(initialized.form.schemaObjects.notes.fields.body.semantics.meaning, "Complete note text.");
  assert.deepEqual(initialized.form.schemaObjects.notes.fields.body.semantics.keywords, []);
  assert.equal(initialized.form.schemaObjects.notes.fields.body.semantics.routingWeight, null);

  initialized.form.schemaObjects.notes.semantics.rowMeaning = "One durable user note.";
  initialized.form.schemaObjects.notes.fields.body.semantics.meaning = "Canonical content interpreted by the agent.";

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

  assert.equal(synchronized.form.schemaObjects.notes.semantics.rowMeaning, "One durable user note.");
  assert.equal(synchronized.form.schemaObjects.notes.fields.body.mechanics.present, false);
  assert.equal(
    synchronized.form.schemaObjects.notes.fields.body.semantics.meaning,
    "Canonical content interpreted by the agent.",
  );
  assert.equal(synchronized.form.schemaObjects.notes.fields.status.semantics.meaning, null);
  assert.deepEqual(synchronized.report.addedFields, ["notes.status"]);
  assert.deepEqual(synchronized.report.removedFields, ["notes.body"]);
});

test("version 1 forms upgrade objects to schemaObjects without losing human answers", () => {
  const { form } = syncSemanticForm({ catalog: initialCatalog });
  const versionOne = structuredClone(form);
  versionOne.contractVersion = 1;
  versionOne.objects = versionOne.schemaObjects;
  delete versionOne.schemaObjects;
  delete versionOne.objects.notes.semantics.derivedFrom;
  delete versionOne.objects.notes.fields.body.semantics.inheritsFrom;
  versionOne.objects.notes.fields.body.semantics.meaning = "Human answer retained during upgrade.";

  const upgraded = upgradeSemanticForm(versionOne);
  assert.equal(upgraded.contractVersion, 2);
  assert.ok(upgraded.schemaObjects.notes);
  assert.equal(upgraded.schemaObjects.notes.fields.body.semantics.meaning, "Human answer retained during upgrade.");
  assert.equal(upgraded.schemaObjects.notes.fields.body.semantics.inheritsFrom, null);
  assert.equal(Object.hasOwn(upgraded, "objects"), false);
});

test("schema fingerprint ignores comments because the JSON form owns semantics", () => {
  const withComments = normalizeCatalog(initialCatalog);
  const withoutCommentsCatalog = structuredClone(initialCatalog);
  withoutCommentsCatalog.objects[0].comment = null;
  withoutCommentsCatalog.objects[0].columns.forEach((column) => { column.comment = null; });
  const withoutComments = normalizeCatalog(withoutCommentsCatalog);
  assert.equal(withComments.fingerprint, withoutComments.fingerprint);
});
