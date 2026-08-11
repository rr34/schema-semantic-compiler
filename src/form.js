import {
  emptyFieldSemantics,
  emptyObjectSemantics,
  emptyRelationshipSemantics,
  FORM_CONTRACT_VERSION,
  FORM_KIND,
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from "./constants.js";
import { normalizeCatalog } from "./catalog.js";
import { asNullableText, clone } from "./util.js";

function mergeKnownShape(defaults, existing) {
  const result = clone(defaults);
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return result;
  for (const key of Object.keys(defaults)) {
    if (Object.hasOwn(existing, key)) result[key] = clone(existing[key]);
  }
  return result;
}

function seededObjectSemantics(comment, shouldSeed) {
  const semantics = emptyObjectSemantics();
  if (shouldSeed) {
    semantics.purpose = asNullableText(comment);
    semantics.rowMeaning = asNullableText(comment);
  }
  return semantics;
}

function seededFieldSemantics(comment, shouldSeed) {
  const semantics = emptyFieldSemantics();
  if (shouldSeed) semantics.meaning = asNullableText(comment);
  return semantics;
}

function mechanicalColumn(column) {
  const { comment: _comment, ...mechanics } = column;
  return mechanics;
}

function mechanicalObject(object) {
  return {
    present: true,
    kind: object.kind,
    definition: object.definition,
    indexes: object.indexes,
  };
}

function unresolvedFields(form) {
  const unresolved = [];
  for (const [objectName, object] of Object.entries(form.objects)) {
    if (object.mechanics.present === false) continue;
    if (!asNullableText(object.semantics.purpose)) unresolved.push(`objects.${objectName}.semantics.purpose`);
    if (!asNullableText(object.semantics.rowMeaning)) unresolved.push(`objects.${objectName}.semantics.rowMeaning`);
    for (const [fieldName, field] of Object.entries(object.fields)) {
      if (field.mechanics.present === false) continue;
      if (!asNullableText(field.semantics.meaning)) {
        unresolved.push(`objects.${objectName}.fields.${fieldName}.semantics.meaning`);
      }
    }
    for (const [relationshipId, relationship] of Object.entries(object.relationships)) {
      if (relationship.mechanics.present === false) continue;
      if (!asNullableText(relationship.semantics.meaning)) {
        unresolved.push(`objects.${objectName}.relationships.${relationshipId}.semantics.meaning`);
      }
    }
  }
  return unresolved;
}

export function assertSemanticForm(form) {
  if (!form || typeof form !== "object" || Array.isArray(form)) throw new Error("Semantic form must be a JSON object.");
  if (form.kind !== FORM_KIND) throw new Error(`Semantic form kind must be ${FORM_KIND}.`);
  if (form.contractVersion !== FORM_CONTRACT_VERSION) {
    throw new Error(`Unsupported semantic form contract version: ${String(form.contractVersion)}.`);
  }
  if (!form.database || typeof form.database !== "object") throw new Error("Semantic form is missing database metadata.");
  if (!form.objects || typeof form.objects !== "object" || Array.isArray(form.objects)) {
    throw new Error("Semantic form is missing its objects map.");
  }
  return form;
}

export function syncSemanticForm({ catalog, existingForm = null, seedComments = false, now = new Date() }) {
  const normalized = normalizeCatalog(catalog);
  if (existingForm) assertSemanticForm(existingForm);
  const existingObjects = existingForm?.objects ?? {};
  const objects = {};
  const changes = { addedObjects: [], removedObjects: [], addedFields: [], removedFields: [], addedRelationships: [], removedRelationships: [] };

  for (const catalogObject of normalized.objects) {
    const previous = existingObjects[catalogObject.name];
    if (!previous) changes.addedObjects.push(catalogObject.name);
    const fields = {};
    const previousFields = previous?.fields ?? {};
    for (const column of catalogObject.columns) {
      const priorField = previousFields[column.name];
      if (!priorField) changes.addedFields.push(`${catalogObject.name}.${column.name}`);
      fields[column.name] = {
        mechanics: { present: true, ...mechanicalColumn(column) },
        semantics: mergeKnownShape(
          seededFieldSemantics(column.comment, seedComments && !priorField),
          priorField?.semantics,
        ),
      };
    }
    for (const [fieldName, priorField] of Object.entries(previousFields)) {
      if (Object.hasOwn(fields, fieldName)) continue;
      changes.removedFields.push(`${catalogObject.name}.${fieldName}`);
      fields[fieldName] = {
        ...clone(priorField),
        mechanics: { ...clone(priorField.mechanics), present: false },
      };
    }

    const relationships = {};
    const previousRelationships = previous?.relationships ?? {};
    for (const relationship of catalogObject.relationships) {
      const priorRelationship = previousRelationships[relationship.id];
      if (!priorRelationship) changes.addedRelationships.push(`${catalogObject.name}.${relationship.id}`);
      relationships[relationship.id] = {
        mechanics: { present: true, ...relationship },
        semantics: mergeKnownShape(emptyRelationshipSemantics(), priorRelationship?.semantics),
      };
    }
    for (const [relationshipId, priorRelationship] of Object.entries(previousRelationships)) {
      if (Object.hasOwn(relationships, relationshipId)) continue;
      changes.removedRelationships.push(`${catalogObject.name}.${relationshipId}`);
      relationships[relationshipId] = {
        ...clone(priorRelationship),
        mechanics: { ...clone(priorRelationship.mechanics), present: false },
      };
    }

    objects[catalogObject.name] = {
      mechanics: mechanicalObject(catalogObject),
      semantics: mergeKnownShape(
        seededObjectSemantics(catalogObject.comment, seedComments && !previous),
        previous?.semantics,
      ),
      fields,
      relationships,
    };
  }

  for (const [objectName, previous] of Object.entries(existingObjects)) {
    if (Object.hasOwn(objects, objectName)) continue;
    changes.removedObjects.push(objectName);
    objects[objectName] = {
      ...clone(previous),
      mechanics: { ...clone(previous.mechanics), present: false },
    };
  }

  const form = {
    kind: FORM_KIND,
    contractVersion: FORM_CONTRACT_VERSION,
    compiler: { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    database: {
      engine: normalized.engine,
      name: normalized.databaseName,
      schemaVersion: normalized.schemaVersion,
      schemaFingerprint: normalized.fingerprint,
      extractedAt: now.toISOString(),
    },
    instructions: {
      humanOwned: "Fill only semantics properties. Null, empty arrays, and empty objects are intentional blanks.",
      compilerOwned: "The compiler refreshes mechanics and database metadata and preserves semantics during synchronization.",
      authority: "The database is authoritative for mechanics. This file is the sole authority for human meaning.",
    },
    objects: Object.fromEntries(Object.entries(objects).sort(([a], [b]) => a.localeCompare(b))),
  };
  const unresolved = unresolvedFields(form);
  return {
    form,
    report: {
      ...changes,
      unresolvedSemanticFields: unresolved,
      unresolvedCount: unresolved.length,
    },
  };
}

export function inspectSemanticForm(form) {
  assertSemanticForm(form);
  const unresolved = unresolvedFields(form);
  const activeObjects = Object.values(form.objects).filter((object) => object.mechanics.present !== false);
  return {
    schemaFingerprint: form.database.schemaFingerprint,
    activeObjectCount: activeObjects.length,
    retiredObjectCount: Object.keys(form.objects).length - activeObjects.length,
    unresolvedSemanticFields: unresolved,
    unresolvedCount: unresolved.length,
  };
}
