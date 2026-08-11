import { fingerprint, stableValue } from "./util.js";

function normalizedColumn(column) {
  return {
    name: String(column.name),
    ordinal: Number(column.ordinal ?? 0),
    type: column.type == null ? null : String(column.type),
    nullable: Boolean(column.nullable),
    default: column.default ?? null,
    primaryKeyPosition: Number(column.primaryKeyPosition ?? 0),
    generated: Boolean(column.generated),
    hidden: Boolean(column.hidden),
    allowedValues: Array.isArray(column.allowedValues) ? [...column.allowedValues] : [],
    comment: column.comment == null ? null : String(column.comment).trim() || null,
  };
}

function normalizedRelationship(relationship) {
  return {
    id: String(relationship.id),
    columns: [...relationship.columns].map(String),
    targetObject: String(relationship.targetObject),
    targetColumns: [...relationship.targetColumns].map(String),
    onUpdate: relationship.onUpdate == null ? null : String(relationship.onUpdate),
    onDelete: relationship.onDelete == null ? null : String(relationship.onDelete),
  };
}

function normalizedIndex(index) {
  return {
    name: String(index.name),
    columns: [...(index.columns ?? [])].map(String),
    unique: Boolean(index.unique),
    partial: Boolean(index.partial),
    origin: index.origin == null ? null : String(index.origin),
  };
}

export function normalizeCatalog(catalog) {
  const mechanics = {
    engine: String(catalog.engine),
    databaseName: catalog.databaseName == null ? null : String(catalog.databaseName),
    schemaVersion: catalog.schemaVersion ?? null,
    objects: [...catalog.objects]
      .map((object) => ({
        name: String(object.name),
        kind: String(object.kind),
        definition: object.definition == null ? null : String(object.definition),
        comment: object.comment == null ? null : String(object.comment).trim() || null,
        columns: [...(object.columns ?? [])].map(normalizedColumn).sort((a, b) => a.ordinal - b.ordinal),
        relationships: [...(object.relationships ?? [])]
          .map(normalizedRelationship)
          .sort((a, b) => a.id.localeCompare(b.id)),
        indexes: [...(object.indexes ?? [])]
          .map(normalizedIndex)
          .sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };

  const fingerprintMechanics = {
    ...mechanics,
    objects: mechanics.objects.map(({ comment: _objectComment, ...object }) => ({
      ...object,
      definition: object.definition
        ?.replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/--[^\r\n]*/g, " ")
        .replace(/\s+/g, " ")
        .trim() || null,
      columns: object.columns.map(({ comment: _fieldComment, ...column }) => column),
    })),
  };

  return {
    ...mechanics,
    fingerprint: fingerprint(stableValue(fingerprintMechanics)),
  };
}
