function rowsFromResult(result) {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0];
  if (Array.isArray(result)) return result;
  throw new Error("MariaDB query executor must return rows or a mysql2 [rows, fields] result.");
}

async function readRows(query, sql, params) {
  return rowsFromResult(await query(sql, params));
}

function parseEnumValues(columnType) {
  const text = String(columnType ?? "");
  if (!/^enum\(/i.test(text)) return [];
  const values = [];
  for (const match of text.matchAll(/'((?:''|\\'|[^'])*)'/g)) {
    values.push(match[1].replaceAll("\\'", "'").replaceAll("''", "'"));
  }
  return values;
}

function groupBy(rows, key) {
  const grouped = new Map();
  for (const row of rows) {
    const value = String(row[key]);
    if (!grouped.has(value)) grouped.set(value, []);
    grouped.get(value).push(row);
  }
  return grouped;
}

export async function extractMariaDbCatalog({ query, databaseName, schemaVersion = null }) {
  if (typeof query !== "function") throw new Error("A MariaDB query function is required.");
  if (!String(databaseName ?? "").trim()) throw new Error("databaseName is required for MariaDB extraction.");

  const [tableRows, columnRows, foreignKeyRows, indexRows, viewRows] = await Promise.all([
    readRows(query, `
      SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_COMMENT
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME
    `, [databaseName]),
    readRows(query, `
      SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_DEFAULT, IS_NULLABLE,
             DATA_TYPE, COLUMN_TYPE, COLUMN_KEY, EXTRA, COLUMN_COMMENT,
             GENERATION_EXPRESSION
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION
    `, [databaseName]),
    readRows(query, `
      SELECT k.CONSTRAINT_NAME, k.TABLE_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION,
             k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
             r.UPDATE_RULE, r.DELETE_RULE
      FROM information_schema.KEY_COLUMN_USAGE k
      JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
       AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
       AND r.TABLE_NAME = k.TABLE_NAME
      WHERE k.CONSTRAINT_SCHEMA = ?
        AND k.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION
    `, [databaseName]),
    readRows(query, `
      SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME,
             INDEX_TYPE
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
    `, [databaseName]),
    readRows(query, `
      SELECT TABLE_NAME, VIEW_DEFINITION, CHECK_OPTION, IS_UPDATABLE,
             SECURITY_TYPE
      FROM information_schema.VIEWS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME
    `, [databaseName]),
  ]);

  const columnsByTable = groupBy(columnRows, "TABLE_NAME");
  const foreignKeysByTable = groupBy(foreignKeyRows, "TABLE_NAME");
  const indexesByTable = groupBy(indexRows, "TABLE_NAME");
  const viewsByTable = new Map(viewRows.map((row) => [String(row.TABLE_NAME), row]));

  const objects = tableRows.map((table) => {
    const name = String(table.TABLE_NAME);
    const primaryKeyPositions = new Map(
      (indexesByTable.get(name) ?? [])
        .filter((index) => index.INDEX_NAME === "PRIMARY")
        .map((index) => [String(index.COLUMN_NAME), Number(index.SEQ_IN_INDEX)]),
    );
    const columns = (columnsByTable.get(name) ?? []).map((column) => ({
      name: column.COLUMN_NAME,
      ordinal: Number(column.ORDINAL_POSITION) - 1,
      type: column.COLUMN_TYPE || column.DATA_TYPE || null,
      nullable: column.IS_NULLABLE === "YES",
      default: column.COLUMN_DEFAULT,
      primaryKeyPosition: primaryKeyPositions.get(String(column.COLUMN_NAME)) ?? 0,
      generated: Boolean(String(column.EXTRA ?? "").includes("GENERATED") || column.GENERATION_EXPRESSION),
      hidden: false,
      allowedValues: parseEnumValues(column.COLUMN_TYPE),
      comment: column.COLUMN_COMMENT || null,
    }));

    const relationships = [];
    for (const [constraintName, entries] of groupBy(foreignKeysByTable.get(name) ?? [], "CONSTRAINT_NAME")) {
      entries.sort((a, b) => Number(a.ORDINAL_POSITION) - Number(b.ORDINAL_POSITION));
      relationships.push({
        id: `fk:${constraintName}`,
        columns: entries.map((entry) => entry.COLUMN_NAME),
        targetObject: entries[0].REFERENCED_TABLE_NAME,
        targetColumns: entries.map((entry) => entry.REFERENCED_COLUMN_NAME),
        onUpdate: entries[0].UPDATE_RULE,
        onDelete: entries[0].DELETE_RULE,
      });
    }

    const indexes = [];
    for (const [indexName, entries] of groupBy(indexesByTable.get(name) ?? [], "INDEX_NAME")) {
      entries.sort((a, b) => Number(a.SEQ_IN_INDEX) - Number(b.SEQ_IN_INDEX));
      indexes.push({
        name: indexName,
        columns: entries.map((entry) => entry.COLUMN_NAME).filter(Boolean),
        unique: Number(entries[0].NON_UNIQUE) === 0,
        partial: false,
        origin: entries[0].INDEX_TYPE || null,
      });
    }

    const view = viewsByTable.get(name);
    return {
      name,
      kind: table.TABLE_TYPE === "VIEW" ? "view" : "table",
      definition: view?.VIEW_DEFINITION ?? null,
      comment: table.TABLE_COMMENT || null,
      columns,
      relationships,
      indexes,
      engine: table.ENGINE ?? null,
      viewSecurity: view?.SECURITY_TYPE ?? null,
    };
  });

  return {
    engine: "mariadb",
    databaseName,
    schemaVersion,
    objects,
  };
}
