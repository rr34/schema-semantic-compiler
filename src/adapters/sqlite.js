import { DatabaseSync } from "node:sqlite";

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function cleanComment(parts) {
  const text = parts
    .join(" ")
    .replace(/^\s*\/\*+|\*+\/\s*$/g, "")
    .replace(/^\s*--\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

export function extractCommentsFromSqliteDefinition(sql) {
  const fieldComments = {};
  const pending = [];
  let objectComment = null;
  let insideBlock = false;
  let beganColumns = false;
  const constraintWords = new Set(["constraint", "primary", "unique", "check", "foreign"]);

  for (const originalLine of String(sql ?? "").split(/\r?\n/)) {
    let line = originalLine;
    const trimmed = line.trim();
    if (!beganColumns && trimmed.includes("(")) beganColumns = true;
    if (!beganColumns) continue;

    if (insideBlock) {
      pending.push(trimmed);
      if (trimmed.includes("*/")) insideBlock = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      pending.push(trimmed);
      if (!trimmed.includes("*/")) insideBlock = true;
      continue;
    }
    if (trimmed.startsWith("--")) {
      pending.push(trimmed);
      continue;
    }

    const columnMatch = line.match(/^\s*[`"\[]?([A-Za-z_][A-Za-z0-9_]*)[`"\]]?\s+(.+)$/);
    if (!columnMatch || constraintWords.has(columnMatch[1].toLowerCase())) {
      if (trimmed && trimmed !== "(" && trimmed !== ")" && trimmed !== ");") pending.length = 0;
      continue;
    }
    const fieldName = columnMatch[1];
    const inlineIndex = line.indexOf("--");
    const inline = inlineIndex >= 0 ? line.slice(inlineIndex) : null;
    const comment = cleanComment([...pending, ...(inline ? [inline] : [])]);
    if (objectComment == null && comment) objectComment = comment;
    if (comment) fieldComments[fieldName] = comment;
    pending.length = 0;
  }

  return { objectComment, fieldComments };
}

function allowedValues(definition, fieldName) {
  const escaped = String(fieldName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(
    `(?:[\\"\\\`\\[]?${escaped}[\\"\\\`\\]]?)\\s+IN\\s*\\(([^)]+)\\)`,
    "i",
  );
  const match = String(definition ?? "").match(matcher);
  if (!match) return [];
  const values = [];
  for (const item of match[1].matchAll(/'((?:''|[^'])*)'/g)) values.push(item[1].replaceAll("''", "'"));
  return values;
}

function groupForeignKeys(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = Number(row.id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return [...grouped.entries()].map(([id, entries]) => {
    entries.sort((a, b) => Number(a.seq) - Number(b.seq));
    const targetObject = String(entries[0].table);
    const columns = entries.map((entry) => String(entry.from));
    const targetColumns = entries.map((entry) => String(entry.to));
    return {
      id: `fk:${columns.join("+")}->${targetObject}.${targetColumns.join("+")}`,
      columns,
      targetObject,
      targetColumns,
      onUpdate: entries[0].on_update,
      onDelete: entries[0].on_delete,
      sqliteId: id,
    };
  });
}

function extractObject(database, row) {
  const name = String(row.name);
  const definition = row.sql == null ? null : String(row.sql);
  const comments = extractCommentsFromSqliteDefinition(definition);
  const columns = database.prepare(`PRAGMA table_xinfo(${quoteIdentifier(name)})`).all().map((column) => ({
    name: column.name,
    ordinal: Number(column.cid),
    type: column.type || null,
    nullable: Number(column.notnull) === 0,
    default: column.dflt_value,
    primaryKeyPosition: Number(column.pk),
    generated: [2, 3].includes(Number(column.hidden)),
    hidden: Number(column.hidden) === 1,
    allowedValues: allowedValues(definition, column.name),
    comment: comments.fieldComments[column.name] ?? null,
  }));
  const relationships = groupForeignKeys(
    database.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`).all(),
  );
  const indexes = database.prepare(`PRAGMA index_list(${quoteIdentifier(name)})`).all().map((index) => ({
    name: index.name,
    columns: database.prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`).all()
      .sort((a, b) => Number(a.seqno) - Number(b.seqno))
      .map((entry) => entry.name)
      .filter(Boolean),
    unique: Number(index.unique) === 1,
    partial: Number(index.partial) === 1,
    origin: index.origin,
  }));
  return {
    name,
    kind: row.type === "view" ? "view" : /^CREATE\s+VIRTUAL\s+TABLE/i.test(definition ?? "") ? "virtual_table" : "table",
    definition,
    comment: comments.objectComment,
    columns,
    relationships,
    indexes,
  };
}

export function extractSqliteCatalog({ database, databaseName = "main", schemaVersion = null }) {
  const shadowNames = new Set();
  try {
    for (const row of database.prepare("PRAGMA table_list").all()) {
      if (row.type === "shadow") shadowNames.add(String(row.name));
    }
  } catch {
    // Older SQLite releases do not expose table_list. sqlite_schema remains usable.
  }
  const rows = database.prepare(`
    SELECT type, name, sql
    FROM sqlite_schema
    WHERE type IN ('table', 'view')
      AND name NOT LIKE 'sqlite_%'
      AND sql IS NOT NULL
    ORDER BY type, name
  `).all().filter((row) => !shadowNames.has(String(row.name)));
  const engineSchemaVersion = database.prepare("PRAGMA schema_version").get()?.schema_version ?? null;
  return {
    engine: "sqlite",
    databaseName,
    schemaVersion: schemaVersion ?? engineSchemaVersion,
    engineSchemaVersion,
    objects: rows.map((row) => extractObject(database, row)),
  };
}

export function extractSqliteCatalogFromFile({ filename, databaseName = "main", schemaVersion = null }) {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    return extractSqliteCatalog({ database, databaseName, schemaVersion });
  } finally {
    database.close();
  }
}
