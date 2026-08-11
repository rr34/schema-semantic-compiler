import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PROJECTION_CONTRACT_VERSION,
  PROJECTION_KIND,
} from "./constants.js";
import { assertSemanticForm } from "./form.js";
import { analyzeSqlReferences } from "./sql-references.js";
import { asNullableText, fingerprint, uniqueSorted } from "./util.js";

function normalizeOperation(operation) {
  if (!operation) return { name: null, purpose: null, objects: [], fields: {} };
  return {
    name: asNullableText(operation.name),
    purpose: asNullableText(operation.purpose),
    objects: Array.isArray(operation.objects) ? operation.objects.map(String) : [],
    fields: operation.fields && typeof operation.fields === "object" ? operation.fields : {},
  };
}

function addReason(reasons, target, reason) {
  if (!reasons[target]) reasons[target] = [];
  if (!reasons[target].includes(reason)) reasons[target].push(reason);
}

function mergeSelections(target, source) {
  const entries = source instanceof Map ? source.entries() : Object.entries(source);
  for (const [objectName, fields] of entries) {
    if (!target.has(objectName)) target.set(objectName, new Set());
    for (const field of fields) target.get(objectName).add(field);
  }
}

function selectDependencies(form, selectedObjects, selectedFields, reasons) {
  const queue = [...selectedObjects];
  const visited = new Set();
  while (queue.length > 0) {
    const objectName = queue.shift();
    if (visited.has(objectName)) continue;
    visited.add(objectName);
    const object = form.objects[objectName];
    if (!object || object.mechanics.present === false) continue;

    if (object.mechanics.kind === "view" && object.mechanics.definition) {
      const references = analyzeSqlReferences(object.mechanics.definition, form.objects);
      for (const dependency of references.objects) {
        if (dependency === objectName) continue;
        if (!selectedObjects.has(dependency)) {
          selectedObjects.add(dependency);
          queue.push(dependency);
        }
        addReason(reasons, dependency, `Required by view ${objectName}.`);
      }
      mergeSelections(selectedFields, new Map(
        Object.entries(references.fields).map(([name, fields]) => [name, new Set(fields)]),
      ));
    }
  }
}

function fieldProjection(field) {
  return {
    type: field.mechanics.type,
    nullable: field.mechanics.nullable,
    primaryKey: Number(field.mechanics.primaryKeyPosition) > 0,
    generated: Boolean(field.mechanics.generated),
    allowedValues: field.mechanics.allowedValues ?? [],
    meaning: field.semantics.meaning,
    units: field.semantics.units,
    format: field.semantics.format,
    allowedValueMeanings: field.semantics.allowedValueMeanings,
    synonyms: field.semantics.synonyms,
    importantRules: field.semantics.importantRules,
    sensitivity: field.semantics.sensitivity,
  };
}

function relationshipProjection(relationship) {
  return {
    columns: relationship.mechanics.columns,
    targetObject: relationship.mechanics.targetObject,
    targetColumns: relationship.mechanics.targetColumns,
    onUpdate: relationship.mechanics.onUpdate,
    onDelete: relationship.mechanics.onDelete,
    meaning: relationship.semantics.meaning,
    cardinality: relationship.semantics.cardinality,
    importantRules: relationship.semantics.importantRules,
  };
}

export function compileSchemaProjection({ form, sql = null, operation = null, now = new Date() }) {
  assertSemanticForm(form);
  const normalizedOperation = normalizeOperation(operation);
  const sqlReferences = sql ? analyzeSqlReferences(sql, form.objects) : { objects: [], fields: {}, selectAll: false };
  const selectedObjects = new Set();
  const selectedFields = new Map();
  const reasons = {};

  for (const objectName of normalizedOperation.objects) {
    if (!Object.hasOwn(form.objects, objectName)) throw new Error(`Unknown semantic object in operation: ${objectName}`);
    selectedObjects.add(objectName);
    addReason(reasons, objectName, "Named by the operation.");
  }
  for (const [objectName, fields] of Object.entries(normalizedOperation.fields)) {
    if (!Object.hasOwn(form.objects, objectName)) throw new Error(`Unknown semantic object in operation fields: ${objectName}`);
    selectedObjects.add(objectName);
    if (!selectedFields.has(objectName)) selectedFields.set(objectName, new Set());
    for (const fieldName of fields) selectedFields.get(objectName).add(String(fieldName));
    addReason(reasons, objectName, "Fields were named by the operation.");
  }
  for (const objectName of sqlReferences.objects) {
    selectedObjects.add(objectName);
    addReason(reasons, objectName, "Referenced by SQL.");
  }
  mergeSelections(selectedFields, sqlReferences.fields);

  if (selectedObjects.size === 0) {
    throw new Error("Projection requires SQL that references a known object or an operation with explicit objects.");
  }
  selectDependencies(form, selectedObjects, selectedFields, reasons);

  const projectionObjects = {};
  const unresolved = [];
  for (const objectName of uniqueSorted([...selectedObjects])) {
    const object = form.objects[objectName];
    if (!object || object.mechanics.present === false) {
      unresolved.push(`${objectName} is absent from the current database schema.`);
      continue;
    }
    const requestedFields = selectedFields.get(objectName) ?? new Set();
    const includeAllFields = sqlReferences.selectAll || requestedFields.size === 0;
    const fields = {};
    for (const [fieldName, field] of Object.entries(object.fields)) {
      if (field.mechanics.present === false) continue;
      if (!includeAllFields && !requestedFields.has(fieldName)) continue;
      fields[fieldName] = fieldProjection(field);
      addReason(reasons, `${objectName}.${fieldName}`, includeAllFields ? "Included to describe the selected object." : "Referenced by the operation or SQL.");
      if (!asNullableText(field.semantics.meaning)) unresolved.push(`${objectName}.${fieldName}: meaning is blank.`);
    }
    for (const fieldName of requestedFields) {
      if (!Object.hasOwn(object.fields, fieldName)) unresolved.push(`${objectName}.${fieldName}: field is not present in the semantic form.`);
    }

    const relationships = {};
    for (const [relationshipId, relationship] of Object.entries(object.relationships)) {
      if (relationship.mechanics.present === false) continue;
      const usesSourceField = relationship.mechanics.columns.some((field) => includeAllFields || requestedFields.has(field));
      const joinsSelectedObject = selectedObjects.has(relationship.mechanics.targetObject);
      if (!usesSourceField && !joinsSelectedObject) continue;
      relationships[relationshipId] = relationshipProjection(relationship);
      addReason(reasons, `${objectName}.${relationshipId}`, usesSourceField ? "Uses a selected foreign-key field." : "Connects selected objects.");
      if (!asNullableText(relationship.semantics.meaning)) unresolved.push(`${objectName}.${relationshipId}: relationship meaning is blank.`);
    }

    if (!asNullableText(object.semantics.purpose)) unresolved.push(`${objectName}: purpose is blank.`);
    if (!asNullableText(object.semantics.rowMeaning)) unresolved.push(`${objectName}: rowMeaning is blank.`);
    projectionObjects[objectName] = {
      kind: object.mechanics.kind,
      purpose: object.semantics.purpose,
      rowMeaning: object.semantics.rowMeaning,
      sourceOfTruth: object.semantics.sourceOfTruth,
      synonyms: object.semantics.synonyms,
      importantRules: object.semantics.importantRules,
      sensitivity: object.semantics.sensitivity,
      fields,
      relationships,
    };
  }

  const deterministicProduct = {
    sourceFingerprint: form.database.schemaFingerprint,
    operation: normalizedOperation,
    sql: sql ?? null,
    projection: projectionObjects,
  };
  const projectionId = fingerprint(deterministicProduct);
  return {
    product: `${PACKAGE_NAME}/${PROJECTION_KIND}`,
    productContractVersion: PROJECTION_CONTRACT_VERSION,
    projectionId,
    compiledAt: now.toISOString(),
    compiler: { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    source: {
      semanticFormKind: form.kind,
      semanticFormContractVersion: form.contractVersion,
      databaseEngine: form.database.engine,
      databaseName: form.database.name,
      schemaVersion: form.database.schemaVersion,
      schemaFingerprint: form.database.schemaFingerprint,
    },
    operation: {
      ...normalizedOperation,
      sql: sql ?? null,
    },
    schemaProjection: {
      purpose: normalizedOperation.purpose,
      objects: projectionObjects,
    },
    compilerTrace: {
      selectionReasons: reasons,
      unresolvedSemantics: uniqueSorted(unresolved),
      notice: "This product explains schema context only. It did not generate, authorize, or execute SQL.",
    },
  };
}
