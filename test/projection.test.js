import assert from "node:assert/strict";
import test from "node:test";
import { compileSchemaProjection, syncSemanticForm } from "../src/index.js";

function completedForm() {
  const catalog = {
    engine: "sqlite",
    databaseName: "main",
    schemaVersion: 4,
    objects: [
      {
        name: "contacts",
        kind: "table",
        definition: "CREATE TABLE contacts (contact_id INTEGER PRIMARY KEY, display_name TEXT NOT NULL)",
        columns: [
          { name: "contact_id", ordinal: 0, type: "INTEGER", nullable: true, primaryKeyPosition: 1 },
          { name: "display_name", ordinal: 1, type: "TEXT", nullable: false, primaryKeyPosition: 0 },
        ],
        relationships: [],
        indexes: [],
      },
      {
        name: "notes",
        kind: "table",
        definition: "CREATE TABLE notes (note_id INTEGER PRIMARY KEY, contact_id INTEGER REFERENCES contacts(contact_id), body TEXT)",
        columns: [
          { name: "note_id", ordinal: 0, type: "INTEGER", nullable: true, primaryKeyPosition: 1 },
          { name: "contact_id", ordinal: 1, type: "INTEGER", nullable: true, primaryKeyPosition: 0 },
          { name: "body", ordinal: 2, type: "TEXT", nullable: true, primaryKeyPosition: 0 },
        ],
        relationships: [{
          id: "fk:contact_id->contacts.contact_id",
          columns: ["contact_id"],
          targetObject: "contacts",
          targetColumns: ["contact_id"],
          onUpdate: "NO ACTION",
          onDelete: "SET NULL",
        }],
        indexes: [],
      },
    ],
  };
  const { form } = syncSemanticForm({ catalog });
  for (const [objectName, object] of Object.entries(form.objects)) {
    object.semantics.purpose = `Purpose of ${objectName}.`;
    object.semantics.rowMeaning = `One ${objectName} row.`;
    for (const [fieldName, field] of Object.entries(object.fields)) field.semantics.meaning = `Meaning of ${objectName}.${fieldName}.`;
    for (const relationship of Object.values(object.relationships)) relationship.semantics.meaning = "The note belongs to this contact.";
  }
  return form;
}

test("projection is unmistakably labeled and contains only SQL-relevant explanation", () => {
  const projection = compileSchemaProjection({
    form: completedForm(),
    sql: `
      SELECT n.body, c.display_name
      FROM notes n
      JOIN contacts c ON c.contact_id = n.contact_id
      WHERE n.note_id = ?
    `,
    operation: { name: "read_note", purpose: "Read a note with its contact label." },
    now: new Date("2026-01-01T00:00:00Z"),
  });

  assert.equal(projection.product, "schema-semantic-compiler/schema-semantic-projection");
  assert.match(projection.projectionId, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(projection.schemaProjection.objects), ["contacts", "notes"]);
  assert.deepEqual(Object.keys(projection.schemaProjection.objects.contacts.fields).sort(), ["contact_id", "display_name"]);
  assert.deepEqual(Object.keys(projection.schemaProjection.objects.notes.fields).sort(), ["body", "contact_id", "note_id"]);
  assert.ok(projection.schemaProjection.objects.notes.relationships["fk:contact_id->contacts.contact_id"]);
  assert.deepEqual(projection.compilerTrace.unresolvedSemantics, []);
  assert.match(projection.compilerTrace.notice, /did not generate, authorize, or execute SQL/);
});

test("operation object selection works without SQL", () => {
  const projection = compileSchemaProjection({
    form: completedForm(),
    operation: { name: "describe_contacts", objects: ["contacts"] },
  });
  assert.deepEqual(Object.keys(projection.schemaProjection.objects), ["contacts"]);
  assert.deepEqual(Object.keys(projection.schemaProjection.objects.contacts.fields), ["contact_id", "display_name"]);
});
