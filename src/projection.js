import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PROJECTION_CONTRACT_VERSION,
  PROJECTION_KIND,
} from "./constants.js";
import { assertSemanticForm, upgradeSemanticForm } from "./form.js";
import { resolveFieldSemantics } from "./inheritance.js";
import { rankSchemaObjects } from "./routing.js";
import { analyzeSqlReferences } from "./sql-references.js";
import { asNullableText, fingerprint, uniqueSorted } from "./util.js";

function omitBlankValues(value) {
  if (value == null) return undefined;
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (Array.isArray(value)) {
    const items = value
      .map((item) => omitBlankValues(item))
      .filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, omitBlankValues(item)])
      .filter(([, item]) => item !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  return value;
}

function normalizeOperation(operation) {
  if (!operation) return { name: null, purpose: null, schemaObjects: [], fields: {} };
  return {
    name: asNullableText(operation.name),
    purpose: asNullableText(operation.purpose),
    schemaObjects: Array.isArray(operation.schemaObjects)
      ? operation.schemaObjects.map(String)
      : Array.isArray(operation.objects)
        ? operation.objects.map(String)
        : [],
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

function fieldProjection(field, semantics) {
  const allowedValues = field.mechanics.allowedValues ?? [];
  const allowedValueMeanings = allowedValues.length > 0
    ? Object.fromEntries(Object.entries(semantics.allowedValueMeanings).filter(([value]) => allowedValues.includes(value)))
    : semantics.allowedValueMeanings;
  return {
    type: field.mechanics.type,
    nullable: field.mechanics.nullable,
    primaryKey: Number(field.mechanics.primaryKeyPosition) > 0,
    generated: Boolean(field.mechanics.generated),
    allowedValues,
    inheritsFrom: semantics.inheritsFrom,
    meaning: semantics.meaning,
    units: semantics.units,
    format: semantics.format,
    allowedValueMeanings,
    synonyms: semantics.synonyms,
    examples: semantics.examples,
    importantRules: semantics.importantRules,
    sensitivity: semantics.sensitivity,
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

export function compileSchemaProjection({
  form,
  sql = null,
  operation = null,
  requestText = null,
  routing = null,
  now = new Date(),
}) {
  form = upgradeSemanticForm(form);
  assertSemanticForm(form);
  const normalizedOperation = normalizeOperation(operation);
  const sqlReferences = sql ? analyzeSqlReferences(sql, form.schemaObjects) : { objects: [], fields: {}, selectAll: false };
  const selectedObjects = new Set();
  const selectedFields = new Map();
  const reasons = {};
  const routingLimit = Math.max(1, Math.min(20, Number.parseInt(routing?.limit ?? 3, 10) || 3));
  const routingMinimumScore = Math.max(0, Number(routing?.minimumScore ?? 3) || 0);
  const routingCandidates = requestText
    ? rankSchemaObjects({
        form,
        requestText,
        limit: routingLimit,
        minimumScore: routingMinimumScore,
      })
    : [];

  for (const candidate of routingCandidates) {
    selectedObjects.add(candidate.schemaObject);
    addReason(
      reasons,
      candidate.schemaObject,
      `Selected from request language with routing score ${candidate.score}.`,
    );
    for (const field of candidate.fieldMatches) {
      addReason(
        reasons,
        `${candidate.schemaObject}.${field.field}`,
        `Matched request language during pre-SQL routing with score ${field.score}.`,
      );
    }
  }

  for (const schemaObjectName of normalizedOperation.schemaObjects) {
    if (!Object.hasOwn(form.schemaObjects, schemaObjectName)) throw new Error(`Unknown semantic schema object in operation: ${schemaObjectName}`);
    selectedObjects.add(schemaObjectName);
    addReason(reasons, schemaObjectName, "Named by the operation.");
  }
  for (const [schemaObjectName, fields] of Object.entries(normalizedOperation.fields)) {
    if (!Object.hasOwn(form.schemaObjects, schemaObjectName)) throw new Error(`Unknown semantic schema object in operation fields: ${schemaObjectName}`);
    selectedObjects.add(schemaObjectName);
    if (!selectedFields.has(schemaObjectName)) selectedFields.set(schemaObjectName, new Set());
    for (const fieldName of fields) selectedFields.get(schemaObjectName).add(String(fieldName));
    addReason(reasons, schemaObjectName, "Fields were named by the operation.");
  }
  for (const objectName of sqlReferences.objects) {
    selectedObjects.add(objectName);
    addReason(reasons, objectName, "Referenced by SQL.");
  }
  mergeSelections(selectedFields, sqlReferences.fields);

  if (selectedObjects.size === 0 && !requestText) {
    throw new Error("Projection requires SQL that references a known schema object or an operation with explicit schemaObjects.");
  }
  const projectionSchemaObjects = {};
  const unresolved = [];
  for (const objectName of uniqueSorted([...selectedObjects])) {
    const schemaObject = form.schemaObjects[objectName];
    if (!schemaObject || schemaObject.mechanics.present === false) {
      unresolved.push(`${objectName} is absent from the current database schema.`);
      continue;
    }
    const requestedFields = selectedFields.get(objectName) ?? new Set();
    const includeAllFields = sqlReferences.selectAll || requestedFields.size === 0;
    const fields = {};
    for (const [fieldName, field] of Object.entries(schemaObject.fields)) {
      if (field.mechanics.present === false) continue;
      if (!includeAllFields && !requestedFields.has(fieldName)) continue;
      const semantics = resolveFieldSemantics(form, objectName, fieldName);
      fields[fieldName] = fieldProjection(field, semantics);
      addReason(reasons, `${objectName}.${fieldName}`, includeAllFields ? "Included to describe the selected object." : "Referenced by the operation or SQL.");
    }
    for (const fieldName of requestedFields) {
      if (!Object.hasOwn(schemaObject.fields, fieldName)) unresolved.push(`${objectName}.${fieldName}: field is not present in the semantic form.`);
    }

    const relationships = {};
    for (const [relationshipId, relationship] of Object.entries(schemaObject.relationships)) {
      if (relationship.mechanics.present === false) continue;
      const usesSourceField = relationship.mechanics.columns.some((field) => includeAllFields || requestedFields.has(field));
      const joinsSelectedObject = selectedObjects.has(relationship.mechanics.targetObject);
      if (!usesSourceField && !joinsSelectedObject) continue;
      relationships[relationshipId] = relationshipProjection(relationship);
      addReason(reasons, `${objectName}.${relationshipId}`, usesSourceField ? "Uses a selected foreign-key field." : "Connects selected objects.");
    }

    projectionSchemaObjects[objectName] = {
      kind: schemaObject.mechanics.kind,
      purpose: schemaObject.semantics.purpose,
      rowMeaning: schemaObject.semantics.rowMeaning,
      sourceOfTruth: schemaObject.semantics.sourceOfTruth,
      derivedFrom: schemaObject.semantics.derivedFrom,
      synonyms: schemaObject.semantics.synonyms,
      importantRules: schemaObject.semantics.importantRules,
      sensitivity: schemaObject.semantics.sensitivity,
      fields,
      relationships,
    };
  }

  const conciseOperation = omitBlankValues({
    ...normalizedOperation,
    requestText: requestText ?? null,
    sql: sql ?? null,
  }) ?? {};
  const conciseSchemaProjection = omitBlankValues({
    purpose: normalizedOperation.purpose,
    schemaObjects: projectionSchemaObjects,
  }) ?? {};
  const conciseCompilerTrace = omitBlankValues({
    selectionReasons: reasons,
    requestRouting: {
      attempted: Boolean(requestText),
      candidateLimit: routingLimit,
      minimumScore: routingMinimumScore,
      candidates: routingCandidates,
    },
    unresolvedSemantics: uniqueSorted(unresolved),
    notice: "This product explains schema context only. It did not generate, authorize, or execute SQL.",
  }) ?? {};
  const conciseSource = omitBlankValues({
    semanticFormKind: form.kind,
    semanticFormContractVersion: form.contractVersion,
    databaseEngine: form.database.engine,
    databaseName: form.database.name,
    schemaVersion: form.database.schemaVersion,
    schemaFingerprint: form.database.schemaFingerprint,
  }) ?? {};

  const deterministicProduct = {
    source: conciseSource,
    operation: conciseOperation,
    schemaProjection: conciseSchemaProjection,
    compilerTrace: conciseCompilerTrace,
  };
  const projectionId = fingerprint(deterministicProduct);
  return {
    product: `${PACKAGE_NAME}/${PROJECTION_KIND}`,
    productContractVersion: PROJECTION_CONTRACT_VERSION,
    projectionId,
    compiledAt: now.toISOString(),
    compiler: { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    source: conciseSource,
    operation: conciseOperation,
    schemaProjection: conciseSchemaProjection,
    compilerTrace: conciseCompilerTrace,
  };
}
