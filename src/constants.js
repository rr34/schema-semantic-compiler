export const PACKAGE_NAME = "schema-semantic-compiler";
export const PACKAGE_VERSION = "0.2.1";
export const FORM_KIND = "schema-semantic-form";
export const FORM_CONTRACT_VERSION = 2;
export const PROJECTION_KIND = "schema-semantic-projection";
export const PROJECTION_CONTRACT_VERSION = 2;

export const emptyObjectSemantics = () => ({
  purpose: null,
  rowMeaning: null,
  sourceOfTruth: null,
  derivedFrom: [],
  synonyms: [],
  keywords: [],
  routingWeight: null,
  importantRules: [],
  sensitivity: null,
});

export const emptyFieldSemantics = () => ({
  inheritsFrom: null,
  meaning: null,
  units: null,
  format: null,
  allowedValueMeanings: {},
  synonyms: [],
  keywords: [],
  routingWeight: null,
  examples: [],
  importantRules: [],
  sensitivity: null,
});

export const emptyRelationshipSemantics = () => ({
  meaning: null,
  cardinality: null,
  importantRules: [],
});
