export const PACKAGE_NAME = "schema-semantic-compiler";
export const PACKAGE_VERSION = "0.1.0";
export const FORM_KIND = "schema-semantic-form";
export const FORM_CONTRACT_VERSION = 1;
export const PROJECTION_KIND = "schema-semantic-projection";
export const PROJECTION_CONTRACT_VERSION = 1;

export const emptyObjectSemantics = () => ({
  purpose: null,
  rowMeaning: null,
  sourceOfTruth: null,
  synonyms: [],
  importantRules: [],
  sensitivity: null,
});

export const emptyFieldSemantics = () => ({
  meaning: null,
  units: null,
  format: null,
  allowedValueMeanings: {},
  synonyms: [],
  examples: [],
  importantRules: [],
  sensitivity: null,
});

export const emptyRelationshipSemantics = () => ({
  meaning: null,
  cardinality: null,
  importantRules: [],
});
