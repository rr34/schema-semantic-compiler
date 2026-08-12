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
  for (const [objectName, object] of Object.entries(form.schemaObjects)) {
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
  assert.deepEqual(Object.keys(projection.schemaProjection.schemaObjects), ["contacts", "notes"]);
  assert.deepEqual(Object.keys(projection.schemaProjection.schemaObjects.contacts.fields).sort(), ["contact_id", "display_name"]);
  assert.deepEqual(Object.keys(projection.schemaProjection.schemaObjects.notes.fields).sort(), ["body", "contact_id", "note_id"]);
  assert.ok(projection.schemaProjection.schemaObjects.notes.relationships["fk:contact_id->contacts.contact_id"]);
  assert.deepEqual(projection.compilerTrace.unresolvedSemantics, []);
  assert.match(projection.compilerTrace.notice, /did not generate, authorize, or execute SQL/);
});

test("operation object selection works without SQL", () => {
  const projection = compileSchemaProjection({
    form: completedForm(),
    operation: { name: "describe_contacts", schemaObjects: ["contacts"] },
  });
  assert.deepEqual(Object.keys(projection.schemaProjection.schemaObjects), ["contacts"]);
  assert.deepEqual(Object.keys(projection.schemaProjection.schemaObjects.contacts.fields), ["contact_id", "display_name"]);
});

test("request routing selects likely objects and fields before SQL without exposing routing metadata as schema context", () => {
  const form = completedForm();
  form.schemaObjects.contacts.semantics.keywords = ["address book", "person"];
  form.schemaObjects.contacts.semantics.routingWeight = 0.9;
  form.schemaObjects.contacts.fields.display_name.semantics.keywords = ["who is", "name"];
  form.schemaObjects.contacts.fields.display_name.semantics.routingWeight = 0.8;
  form.schemaObjects.notes.semantics.keywords = ["memo", "write down"];
  form.schemaObjects.notes.semantics.routingWeight = 0.4;

  const projection = compileSchemaProjection({
    form,
    requestText: "Who is in my address book?",
    now: new Date("2026-01-01T00:00:00Z"),
  });

  assert.deepEqual(Object.keys(projection.schemaProjection.schemaObjects), ["contacts"]);
  assert.deepEqual(Object.keys(projection.schemaProjection.schemaObjects.contacts.fields), ["contact_id", "display_name"]);
  assert.equal(Object.hasOwn(projection.schemaProjection.schemaObjects.contacts, "keywords"), false);
  assert.equal(Object.hasOwn(projection.schemaProjection.schemaObjects.contacts.fields.display_name, "routingWeight"), false);
  assert.equal(projection.operation.requestText, "Who is in my address book?");
  assert.equal(projection.compilerTrace.requestRouting.candidates[0].schemaObject, "contacts");
  assert.ok(projection.compilerTrace.requestRouting.candidates[0].score > 0);
  assert.equal(projection.compilerTrace.requestRouting.candidates[0].fieldMatches[0].field, "display_name");
});

test("request routing returns an inspectable empty projection when nothing matches", () => {
  const projection = compileSchemaProjection({
    form: completedForm(),
    requestText: "Explain how photosynthesis works.",
  });
  assert.deepEqual(projection.schemaProjection.schemaObjects, {});
  assert.deepEqual(projection.compilerTrace.requestRouting.candidates, []);
});

test("derived views inherit field semantics without duplicating source objects in projections", () => {
  const catalog = {
    engine: "sqlite",
    databaseName: "main",
    schemaVersion: 1,
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
        name: "named_contacts",
        kind: "view",
        definition: "CREATE VIEW named_contacts AS SELECT contact_id, display_name FROM contacts",
        columns: [
          { name: "contact_id", ordinal: 0, type: "INTEGER", nullable: true, primaryKeyPosition: 0 },
          { name: "display_name", ordinal: 1, type: "TEXT", nullable: true, primaryKeyPosition: 0 },
        ],
        relationships: [],
        indexes: [],
      },
    ],
  };
  const { form } = syncSemanticForm({ catalog });
  form.schemaObjects.contacts.semantics.purpose = "Store contacts.";
  form.schemaObjects.contacts.semantics.rowMeaning = "One contact.";
  form.schemaObjects.contacts.fields.contact_id.semantics.meaning = "Stable contact identifier.";
  form.schemaObjects.contacts.fields.display_name.semantics.meaning = "Name shown for the contact.";
  form.schemaObjects.named_contacts.semantics.purpose = "Present contact names.";
  form.schemaObjects.named_contacts.semantics.rowMeaning = "One named contact.";

  assert.deepEqual(form.schemaObjects.named_contacts.semantics.derivedFrom, ["contacts"]);
  assert.equal(form.schemaObjects.named_contacts.fields.display_name.semantics.inheritsFrom, "contacts.display_name");
  assert.equal(form.schemaObjects.named_contacts.fields.display_name.semantics.meaning, null);

  const projection = compileSchemaProjection({
    form,
    operation: {
      name: "read_named_contacts",
      schemaObjects: ["named_contacts"],
      fields: { named_contacts: ["display_name"] },
    },
  });
  assert.deepEqual(Object.keys(projection.schemaProjection.schemaObjects), ["named_contacts"]);
  const field = projection.schemaProjection.schemaObjects.named_contacts.fields.display_name;
  assert.equal(field.inheritsFrom, "contacts.display_name");
  assert.equal(field.meaning, "Name shown for the contact.");
  assert.deepEqual(projection.compilerTrace.unresolvedSemantics, []);
});
