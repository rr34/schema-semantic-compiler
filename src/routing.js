import { assertSemanticForm, upgradeSemanticForm } from "./form.js";
import { resolveFieldSemantics } from "./inheritance.js";
import { asNullableText } from "./util.js";

const MATCH_WEIGHTS = Object.freeze({
  schemaObjectName: 10,
  objectSynonym: 8,
  objectKeyword: 6,
  fieldName: 5,
  fieldSynonym: 4,
  fieldKeyword: 3,
});

function normalizedSearchText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replaceAll(/[_-]+/g, " ")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replaceAll(/\s+/g, " ");
}

function containsPhrase(request, phrase) {
  const normalized = normalizedSearchText(phrase);
  return normalized && ` ${request} `.includes(` ${normalized} `);
}

function routingWeight(value, label) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`${label} routingWeight must be null or a number from 0 through 1.`);
  }
  return number;
}

function weightFactor(value) {
  return value == null ? 1 : 0.75 + (value * 0.5);
}

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

function matchingTerms(request, terms, score, label) {
  const seen = new Set();
  const matches = [];
  for (const term of terms ?? []) {
    const normalized = normalizedSearchText(term);
    if (!normalized || seen.has(normalized) || !containsPhrase(request, normalized)) continue;
    seen.add(normalized);
    matches.push({ source: label, term: String(term), score });
  }
  return matches;
}

function fieldCandidate(request, form, schemaObjectName, fieldName, field) {
  const semantics = resolveFieldSemantics(form, schemaObjectName, fieldName);
  const matches = [
    ...matchingTerms(request, [fieldName], MATCH_WEIGHTS.fieldName, "field name"),
    ...matchingTerms(request, semantics.synonyms, MATCH_WEIGHTS.fieldSynonym, "field synonym"),
    ...matchingTerms(request, semantics.keywords, MATCH_WEIGHTS.fieldKeyword, "field keyword"),
  ];
  if (matches.length === 0) return null;
  const prior = routingWeight(semantics.routingWeight, `${schemaObjectName}.${fieldName}`);
  const lexicalScore = matches.reduce((sum, match) => sum + match.score, 0);
  return {
    field: fieldName,
    score: rounded(lexicalScore * weightFactor(prior)),
    lexicalScore,
    routingWeight: prior,
    matches,
  };
}

export function rankSchemaObjects({ form, requestText, limit = 3, minimumScore = 3 }) {
  form = upgradeSemanticForm(form);
  assertSemanticForm(form);
  const request = normalizedSearchText(asNullableText(requestText));
  if (!request) throw new Error("Schema routing requires nonblank requestText.");
  const boundedLimit = Math.max(1, Math.min(20, Number.parseInt(limit, 10) || 3));
  const boundedMinimumScore = Math.max(0, Number(minimumScore) || 0);
  const candidates = [];

  for (const [schemaObjectName, schemaObject] of Object.entries(form.schemaObjects)) {
    if (schemaObject.mechanics.present === false) continue;
    const objectMatches = [
      ...matchingTerms(request, [schemaObjectName], MATCH_WEIGHTS.schemaObjectName, "schema object name"),
      ...matchingTerms(request, schemaObject.semantics.synonyms, MATCH_WEIGHTS.objectSynonym, "schema object synonym"),
      ...matchingTerms(request, schemaObject.semantics.keywords, MATCH_WEIGHTS.objectKeyword, "schema object keyword"),
    ];
    const fieldMatches = [];
    for (const [fieldName, field] of Object.entries(schemaObject.fields)) {
      if (field.mechanics.present === false) continue;
      const candidate = fieldCandidate(request, form, schemaObjectName, fieldName, field);
      if (candidate) fieldMatches.push(candidate);
    }
    if (objectMatches.length === 0 && fieldMatches.length === 0) continue;

    fieldMatches.sort((a, b) => b.score - a.score || a.field.localeCompare(b.field));
    const lexicalScore = objectMatches.reduce((sum, match) => sum + match.score, 0)
      + fieldMatches.reduce((sum, field) => sum + field.score, 0);
    const prior = routingWeight(schemaObject.semantics.routingWeight, schemaObjectName);
    const score = rounded(lexicalScore * weightFactor(prior));
    if (score < boundedMinimumScore) continue;
    candidates.push({
      schemaObject: schemaObjectName,
      kind: schemaObject.mechanics.kind,
      score,
      lexicalScore: rounded(lexicalScore),
      routingWeight: prior,
      objectMatches,
      fieldMatches,
    });
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.schemaObject.localeCompare(b.schemaObject))
    .slice(0, boundedLimit);
}
