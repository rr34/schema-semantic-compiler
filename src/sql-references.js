const KEYWORDS = new Set([
  "all", "and", "as", "asc", "between", "by", "case", "cross", "delete", "desc",
  "distinct", "else", "end", "exists", "from", "full", "group", "having", "in",
  "inner", "insert", "into", "is", "join", "left", "like", "limit", "not", "null",
  "offset", "on", "or", "order", "outer", "recursive", "returning", "right", "select",
  "set", "then", "union", "update", "using", "values", "when", "where", "with",
]);

function unquote(token) {
  if ((token.startsWith("`") && token.endsWith("`")) || (token.startsWith('"') && token.endsWith('"'))) {
    return token.slice(1, -1).replaceAll(token[0] + token[0], token[0]);
  }
  if (token.startsWith("[") && token.endsWith("]")) return token.slice(1, -1);
  return token;
}

function scrubSql(sql) {
  return String(sql ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, (match) => " ".repeat(match.length))
    .replace(/--[^\r\n]*/g, (match) => " ".repeat(match.length))
    .replace(/'(?:''|[^'])*'/g, (match) => " ".repeat(match.length));
}

function tokenize(sql) {
  const matches = scrubSql(sql).match(/`(?:``|[^`])+`|"(?:""|[^"])+"|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*|\*|\.|,|\(|\)/g);
  return (matches ?? []).map((raw) => ({ raw, value: unquote(raw), lower: unquote(raw).toLowerCase() }));
}

function isIdentifier(token) {
  return Boolean(token) && !["*", ".", ",", "(", ")"].includes(token.raw) && !KEYWORDS.has(token.lower);
}

function readQualifiedName(tokens, start) {
  if (!isIdentifier(tokens[start])) return null;
  const parts = [tokens[start].value];
  let end = start;
  while (tokens[end + 1]?.raw === "." && isIdentifier(tokens[end + 2])) {
    parts.push(tokens[end + 2].value);
    end += 2;
  }
  return { parts, end };
}

export function analyzeSqlReferences(sql, availableObjects = {}) {
  const tokens = tokenize(sql);
  const canonicalObject = new Map(
    Object.keys(availableObjects).map((name) => [name.toLowerCase(), name]),
  );
  const objects = new Set();
  const aliases = new Map();
  const fields = new Map();
  let selectAll = false;

  const addField = (objectName, fieldName) => {
    if (!objectName || !fieldName) return;
    if (!fields.has(objectName)) fields.set(objectName, new Set());
    fields.get(objectName).add(fieldName);
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!["from", "join", "update", "into"].includes(token.lower)) continue;
    if (tokens[index + 1]?.raw === "(") continue;
    const qualified = readQualifiedName(tokens, index + 1);
    if (!qualified) continue;
    const rawName = qualified.parts.at(-1);
    const objectName = canonicalObject.get(rawName.toLowerCase()) ?? rawName;
    if (!Object.hasOwn(availableObjects, objectName)) continue;
    objects.add(objectName);
    aliases.set(rawName.toLowerCase(), objectName);
    let aliasIndex = qualified.end + 1;
    if (tokens[aliasIndex]?.lower === "as") aliasIndex += 1;
    if (isIdentifier(tokens[aliasIndex])) aliases.set(tokens[aliasIndex].lower, objectName);
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const left = tokens[index];
    if (!isIdentifier(left) || tokens[index + 1]?.raw !== ".") continue;
    const objectName = aliases.get(left.lower) ?? canonicalObject.get(left.lower);
    if (!objectName) continue;
    const right = tokens[index + 2];
    if (right?.raw === "*") {
      selectAll = true;
      continue;
    }
    if (isIdentifier(right) && Object.hasOwn(availableObjects[objectName]?.fields ?? {}, right.value)) {
      addField(objectName, right.value);
    }
  }

  if (tokens.some((token, index) => token.raw === "*" && tokens[index - 1]?.raw !== ".")) selectAll = true;

  for (const token of tokens) {
    if (!isIdentifier(token) || aliases.has(token.lower) || canonicalObject.has(token.lower)) continue;
    const matches = [...objects].filter((objectName) =>
      Object.hasOwn(availableObjects[objectName]?.fields ?? {}, token.value),
    );
    if (matches.length === 1) addField(matches[0], token.value);
  }

  return {
    objects: [...objects],
    fields: Object.fromEntries([...fields].map(([name, values]) => [name, [...values]])),
    selectAll,
  };
}
