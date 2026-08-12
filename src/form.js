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
import { resolveFieldSemantics } from "./inheritance.js";
import { analyzeSqlReferences } from "./sql-references.js";
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

function inheritanceCandidates(schemaObjects, schemaObjectName, schemaObject) {
  if (schemaObject.mechanics.kind !== "view" || !schemaObject.mechanics.definition) return [];
  return analyzeSqlReferences(schemaObject.mechanics.definition, schemaObjects).objects
    .filter((name) => name !== schemaObjectName && schemaObjects[name]?.mechanics.present !== false);
}

function seedDerivedInheritance(form, { schemaObjectNames = null, fieldNames = null } = {}) {
  for (const [schemaObjectName, schemaObject] of Object.entries(form.schemaObjects)) {
    const seedSchemaObject = schemaObjectNames == null || schemaObjectNames.has(schemaObjectName);
    if (seedSchemaObject && schemaObject.semantics.derivedFrom.length === 0) {
      schemaObject.semantics.derivedFrom = inheritanceCandidates(form.schemaObjects, schemaObjectName, schemaObject);
    }
    const sources = schemaObject.semantics.derivedFrom;
    if (sources.length === 0) continue;
    for (const [fieldName, field] of Object.entries(schemaObject.fields)) {
      const qualifiedName = `${schemaObjectName}.${fieldName}`;
      const seedField = fieldNames == null || fieldNames.has(qualifiedName) || seedSchemaObject;
      if (!seedField || asNullableText(field.semantics.inheritsFrom)) continue;
      const matches = sources.filter((sourceName) => {
        const sourceField = form.schemaObjects[sourceName]?.fields?.[fieldName];
        return sourceField && sourceField.mechanics.present !== false;
      });
      if (matches.length === 1) field.semantics.inheritsFrom = `${matches[0]}.${fieldName}`;
    }
  }
}

function unresolvedFields(form) {
  const unresolved = [];
  for (const [schemaObjectName, schemaObject] of Object.entries(form.schemaObjects)) {
    if (schemaObject.mechanics.present === false) continue;
    if (!asNullableText(schemaObject.semantics.purpose)) unresolved.push(`schemaObjects.${schemaObjectName}.semantics.purpose`);
    if (!asNullableText(schemaObject.semantics.rowMeaning)) unresolved.push(`schemaObjects.${schemaObjectName}.semantics.rowMeaning`);
    for (const [fieldName, field] of Object.entries(schemaObject.fields)) {
      if (field.mechanics.present === false) continue;
      const resolved = resolveFieldSemantics(form, schemaObjectName, fieldName);
      if (!asNullableText(resolved.meaning)) {
        unresolved.push(`schemaObjects.${schemaObjectName}.fields.${fieldName}.semantics.meaning`);
      }
    }
    for (const [relationshipId, relationship] of Object.entries(schemaObject.relationships)) {
      if (relationship.mechanics.present === false) continue;
      if (!asNullableText(relationship.semantics.meaning)) {
        unresolved.push(`schemaObjects.${schemaObjectName}.relationships.${relationshipId}.semantics.meaning`);
      }
    }
  }
  return unresolved;
}

function upgradeSchemaObject(schemaObject) {
  const upgraded = clone(schemaObject);
  upgraded.semantics = mergeKnownShape(emptyObjectSemantics(), schemaObject.semantics);
  upgraded.fields = Object.fromEntries(Object.entries(schemaObject.fields ?? {}).map(([fieldName, field]) => [
    fieldName,
    {
      ...clone(field),
      semantics: mergeKnownShape(emptyFieldSemantics(), field.semantics),
    },
  ]));
  upgraded.relationships = Object.fromEntries(Object.entries(schemaObject.relationships ?? {}).map(([id, relationship]) => [
    id,
    {
      ...clone(relationship),
      semantics: mergeKnownShape(emptyRelationshipSemantics(), relationship.semantics),
    },
  ]));
  return upgraded;
}

export function upgradeSemanticForm(form) {
  if (!form || typeof form !== "object" || Array.isArray(form)) throw new Error("Semantic form must be a JSON object.");
  if (form.kind !== FORM_KIND) throw new Error(`Semantic form kind must be ${FORM_KIND}.`);
  if (form.contractVersion === FORM_CONTRACT_VERSION && form.schemaObjects) return form;
  if (form.contractVersion !== 1 || !form.objects || typeof form.objects !== "object" || Array.isArray(form.objects)) {
    throw new Error(`Unsupported semantic form contract version: ${String(form.contractVersion)}.`);
  }
  const upgraded = clone(form);
  upgraded.contractVersion = FORM_CONTRACT_VERSION;
  upgraded.compiler = { name: PACKAGE_NAME, version: PACKAGE_VERSION };
  upgraded.schemaObjects = Object.fromEntries(
    Object.entries(form.objects).map(([name, schemaObject]) => [name, upgradeSchemaObject(schemaObject)]),
  );
  delete upgraded.objects;
  seedDerivedInheritance(upgraded);
  return upgraded;
}

export function assertSemanticForm(form) {
  if (!form || typeof form !== "object" || Array.isArray(form)) throw new Error("Semantic form must be a JSON object.");
  if (form.kind !== FORM_KIND) throw new Error(`Semantic form kind must be ${FORM_KIND}.`);
  if (form.contractVersion !== FORM_CONTRACT_VERSION) {
    throw new Error(`Unsupported semantic form contract version: ${String(form.contractVersion)}.`);
  }
  if (!form.database || typeof form.database !== "object") throw new Error("Semantic form is missing database metadata.");
  if (!form.schemaObjects || typeof form.schemaObjects !== "object" || Array.isArray(form.schemaObjects)) {
    throw new Error("Semantic form is missing its schemaObjects map.");
  }
  return form;
}

export function syncSemanticForm({ catalog, existingForm = null, seedComments = false, now = new Date() }) {
  const normalized = normalizeCatalog(catalog);
  const upgradedExistingForm = existingForm ? upgradeSemanticForm(existingForm) : null;
  if (upgradedExistingForm) assertSemanticForm(upgradedExistingForm);
  const existingSchemaObjects = upgradedExistingForm?.schemaObjects ?? {};
  const schemaObjects = {};
  const changes = { addedSchemaObjects: [], removedSchemaObjects: [], addedFields: [], removedFields: [], addedRelationships: [], removedRelationships: [] };

  for (const catalogObject of normalized.objects) {
    const previous = existingSchemaObjects[catalogObject.name];
    if (!previous) changes.addedSchemaObjects.push(catalogObject.name);
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

    schemaObjects[catalogObject.name] = {
      mechanics: mechanicalObject(catalogObject),
      semantics: mergeKnownShape(
        seededObjectSemantics(catalogObject.comment, seedComments && !previous),
        previous?.semantics,
      ),
      fields,
      relationships,
    };
  }

  for (const [schemaObjectName, previous] of Object.entries(existingSchemaObjects)) {
    if (Object.hasOwn(schemaObjects, schemaObjectName)) continue;
    changes.removedSchemaObjects.push(schemaObjectName);
    schemaObjects[schemaObjectName] = {
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
    schemaObjects: Object.fromEntries(Object.entries(schemaObjects).sort(([a], [b]) => a.localeCompare(b))),
  };
  seedDerivedInheritance(form, {
    schemaObjectNames: new Set(changes.addedSchemaObjects),
    fieldNames: new Set(changes.addedFields),
  });
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
  const upgraded = upgradeSemanticForm(form);
  assertSemanticForm(upgraded);
  const unresolved = unresolvedFields(upgraded);
  const activeSchemaObjects = Object.values(upgraded.schemaObjects).filter((schemaObject) => schemaObject.mechanics.present !== false);
  return {
    schemaFingerprint: upgraded.database.schemaFingerprint,
    activeSchemaObjectCount: activeSchemaObjects.length,
    retiredSchemaObjectCount: Object.keys(upgraded.schemaObjects).length - activeSchemaObjects.length,
    unresolvedSemanticFields: unresolved,
    unresolvedCount: unresolved.length,
  };
}
