import { emptyFieldSemantics } from "./constants.js";
import { asNullableText, clone } from "./util.js";

function fieldReference(reference) {
  const value = asNullableText(reference);
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Invalid inherited field reference: ${value}. Expected schemaObject.field.`);
  }
  return { schemaObjectName: value.slice(0, separator), fieldName: value.slice(separator + 1) };
}

function mergeArrays(inherited, own) {
  return [...new Set([...(inherited ?? []), ...(own ?? [])])];
}

function mergeExamples(inherited, own) {
  const values = [...(inherited ?? []), ...(own ?? [])];
  const seen = new Set();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function resolveFieldSemantics(form, schemaObjectName, fieldName, stack = []) {
  const schemaObject = form.schemaObjects[schemaObjectName];
  const field = schemaObject?.fields?.[fieldName];
  if (!schemaObject || schemaObject.mechanics.present === false || !field || field.mechanics.present === false) {
    throw new Error(`Inherited field does not exist in the current schema: ${schemaObjectName}.${fieldName}.`);
  }

  const key = `${schemaObjectName}.${fieldName}`;
  if (stack.includes(key)) throw new Error(`Field semantic inheritance cycle: ${[...stack, key].join(" -> ")}.`);

  const own = { ...emptyFieldSemantics(), ...clone(field.semantics) };
  const reference = fieldReference(own.inheritsFrom);
  if (!reference) return own;

  const inherited = resolveFieldSemantics(
    form,
    reference.schemaObjectName,
    reference.fieldName,
    [...stack, key],
  );
  return {
    inheritsFrom: own.inheritsFrom,
    meaning: asNullableText(own.meaning) ?? inherited.meaning,
    units: asNullableText(own.units) ?? inherited.units,
    format: asNullableText(own.format) ?? inherited.format,
    allowedValueMeanings: {
      ...(inherited.allowedValueMeanings ?? {}),
      ...(own.allowedValueMeanings ?? {}),
    },
    synonyms: mergeArrays(inherited.synonyms, own.synonyms),
    keywords: mergeArrays(inherited.keywords, own.keywords),
    routingWeight: own.routingWeight ?? inherited.routingWeight,
    examples: mergeExamples(inherited.examples, own.examples),
    importantRules: mergeArrays(inherited.importantRules, own.importantRules),
    sensitivity: asNullableText(own.sensitivity) ?? inherited.sensitivity,
  };
}
