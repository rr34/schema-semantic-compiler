# Schema Semantic Compiler

A deterministic, read-and-explain-only compiler for turning database structure and human-authored meaning into small, inspectable context products for AI agents.

> A complex database is mechanically organized but semantically unusable to an LLM. Schema Semantic Compiler combines its exact schema with one authoritative human-maintained JSON form and turns only the relevant parts into a small, inspectable context projection.

The compiler does not use AI. It does not inspect application rows, generate SQL, authorize SQL, or execute SQL.

## Why

Database schemas preserve mechanical truth: names, types, keys, relationships, constraints, views, and indexes. They usually do not fully explain what a row means, which content is authoritative, why a relationship exists, or which implicit business rule matters to an agent.

Sending an entire large schema to a language model wastes context and still leaves ambiguity. Hand-writing a prompt fragment for every query creates duplication and drift.

Schema Semantic Compiler keeps one fillable JSON form beside the consuming project. It refreshes mechanical facts from SQLite or MariaDB while preserving human semantic fields, then compiles only the explanation relevant to a particular operation or SQL statement.

## One authoritative form

Each consuming project owns one file, normally:

```text
db/schema-semantics.json
```

There are no separate answer, question, and generated-manifest files. Mechanical and semantic properties sit together:

```json
{
  "kind": "schema-semantic-form",
  "contractVersion": 2,
  "database": {
    "engine": "sqlite",
    "schemaVersion": 3,
    "schemaFingerprint": "..."
  },
  "schemaObjects": {
    "activity_events": {
      "mechanics": {
        "present": true,
        "kind": "table"
      },
      "semantics": {
        "purpose": "Preserve complete chronological agent activity.",
        "rowMeaning": "One observable event in the agent system.",
        "sourceOfTruth": true,
        "derivedFrom": [],
        "synonyms": ["ledger event"],
        "keywords": ["what happened", "agent activity", "tool call"],
        "routingWeight": 0.8,
        "importantRules": [
          "Use event_seq for exact local ledger ordering."
        ],
        "sensitivity": "May contain private user content."
      },
      "fields": {
        "content_text": {
          "mechanics": {
            "present": true,
            "name": "content_text",
            "type": "TEXT",
            "nullable": true
          },
          "semantics": {
            "inheritsFrom": null,
            "meaning": "Complete human-readable content visible for the event.",
            "units": null,
            "format": "plain text",
            "allowedValueMeanings": {},
            "synonyms": ["event content"],
            "keywords": ["request text", "response text", "what was said"],
            "routingWeight": 0.9,
            "examples": [],
            "importantRules": [],
            "sensitivity": "May contain private user content."
          }
        }
      }
    }
  }
}
```

`schemaObjects` is the standard database umbrella for tables, views, and other named schema structures represented by the form. It avoids confusing those database structures with JSON's own object value type.

Derived schema objects retain their own purpose and filtering or calculation rules without duplicating every source-field explanation:

```json
{
  "schemaObjects": {
    "upcoming_calendar": {
      "semantics": {
        "purpose": "Select future tentative and confirmed events.",
        "rowMeaning": "One upcoming calendar event.",
        "sourceOfTruth": false,
        "derivedFrom": ["calendar_events"]
      },
      "fields": {
        "title": {
          "semantics": {
            "inheritsFrom": "calendar_events.title",
            "meaning": null
          }
        }
      }
    }
  }
}
```

At projection time the compiler recursively resolves inherited field meaning, units, format, allowed-value explanations, synonyms, rules, examples, and sensitivity. A nonblank value on the derived field supplements or overrides the inherited value. Invalid references and inheritance cycles fail visibly.

Ownership is explicit:

- The compiler owns `mechanics` and top-level database metadata.
- The human owns `semantics`.
- `null`, `[]`, and `{}` are visible blanks to fill, not separately generated questions.
- The database remains authoritative for mechanics.
- The JSON form is the sole authority for human meaning.

The form contract is published at [`schemas/schema-semantic-form.schema.json`](schemas/schema-semantic-form.schema.json).

## Comments are bootstrap input only

`init` imports native MariaDB table/column comments and best-effort SQLite DDL comments into otherwise blank semantic properties. This is a one-time migration aid.

Ordinary `sync` does not read comments into semantics. After initialization, the JSON form is authoritative and database comments can be phased out without changing the mechanical schema fingerprint. `sync --seed-comments` is available only for an intentional later import of comments on newly discovered objects or fields.

## Output product

Every projection is unmistakably labeled:

```json
{
  "product": "schema-semantic-compiler/schema-semantic-projection",
  "productContractVersion": 2,
  "projectionId": "d74d...",
  "compiler": {
    "name": "schema-semantic-compiler",
    "version": "0.2.1"
  },
  "source": {
    "databaseEngine": "sqlite",
    "schemaVersion": 3,
    "schemaFingerprint": "4e4a..."
  },
  "schemaProjection": {
    "schemaObjects": {}
  },
  "compilerTrace": {
    "notice": "This product explains schema context only. It did not generate, authorize, or execute SQL."
  }
}
```

The host application can attach this product to a query and its result. Observability can search for the exact `product` value, group by `projectionId`, and display the schema fingerprint, included objects, selection reasons, and unresolved semantics.

Compiled products recursively omit blank strings, `null`, empty arrays, and empty objects. Meaningful `false` and `0` values remain. The maintained semantic form keeps its visible blanks for humans to fill in, while per-request projections contain only information the compiler actually has. Use `ssc check` to inspect incomplete human semantics; projections do not repeat blank-field warnings.

The same product can be compiled before SQL or structured tool arguments exist. `keywords` may contain individual terms or short phrases; they are deterministic routing inputs, not extra prose for the LLM. `routingWeight` is a human-controlled number from 0 through 1 that modestly adjusts an actual language match. It never selects an otherwise unrelated object by itself. The projection sent to the LLM omits both properties; the compiler trace retains scores and exact match reasons for observability.

The projection contract is published at [`schemas/schema-semantic-projection.schema.json`](schemas/schema-semantic-projection.schema.json).

## CLI

Requires Node.js 22.5 or newer. The SQLite adapter uses Node's built-in `node:sqlite`. MariaDB CLI extraction uses the optional `mysql2` dependency.

### Initialize from SQLite

```bash
ssc init \
  --engine sqlite \
  --database ./data/agent.sqlite \
  --form ./db/schema-semantics.json
```

Initialization refuses to overwrite an existing form unless `--force` is supplied.

### Initialize from MariaDB

```bash
MYSQL_HOST=localhost \
MYSQL_USER=app \
MYSQL_PASSWORD='...' \
MYSQL_DATABASE=app \
ssc init \
  --engine mariadb \
  --database app \
  --schema-version 12 \
  --form ./db/schema-semantics.json
```

`SSC_MARIADB_URL` may be used instead. Prefer environment variables to command-line passwords so credentials do not appear in process listings or shell history.

### Synchronize after a migration

```bash
ssc sync \
  --engine sqlite \
  --database ./data/agent.sqlite \
  --form ./db/schema-semantics.json
```

Synchronization:

- Refreshes compiler-owned mechanics.
- Preserves every human-owned semantic value.
- Adds blank semantic forms for new schema objects, fields, and relationships.
- Seeds inspectable field inheritance for unambiguous fields in newly discovered views.
- Marks removed elements with `mechanics.present: false` instead of discarding their explanations.
- Reports additions, removals, and unresolved semantic fields.
- Updates the schema fingerprint.

### Inspect incomplete semantics

```bash
ssc check --form ./db/schema-semantics.json
```

This reports blank purposes, row meanings, field meanings, and relationship meanings. It does not create a second question file.

### Compile from SQL

```bash
ssc project \
  --form ./db/schema-semantics.json \
  --sql-file ./query.sql \
  --output ./projection.json
```

The SQL parser is conservative and read-only. It finds referenced schema objects and fields; it does not validate, authorize, rewrite, generate, or run the statement.

### Compile from request language before SQL

```bash
ssc project \
  --form ./db/schema-semantics.json \
  --request "What appointments do I have coming up?"
```

`--request-file` accepts the request from a file. Request routing compares normalized whole words and short phrases with schema-object and field names, synonyms, and human-maintained keywords. It returns the highest-scoring objects, their complete field explanations, relationship context, and an observable scoring trace. If nothing matches, it returns an inspectable empty projection instead of inventing relevance.

This pre-SQL projection is approximate. A host can place only its `schemaProjection` in model context, use the trace for observability, and then compile an exact second projection from the resulting operation or SQL.

### Compile from an explicit operation

An operation can identify relevant schema objects without SQL:

```json
{
  "name": "read_recent_activity",
  "purpose": "Read the latest observable agent events.",
  "schemaObjects": ["activity_events"],
  "fields": {
    "activity_events": [
      "event_seq",
      "event_type",
      "status",
      "content_text"
    ]
  }
}
```

```bash
ssc project \
  --form ./db/schema-semantics.json \
  --operation-file ./operation.json
```

SQL and an explicit operation may be supplied together. Their schema references are combined.

## JavaScript API

```js
import {
  compileSchemaProjection,
  syncSemanticForm,
} from "schema-semantic-compiler";
import {
  extractSqliteCatalogFromFile,
} from "schema-semantic-compiler/sqlite";

const catalog = extractSqliteCatalogFromFile({
  filename: "./data/agent.sqlite",
});

const { form, report } = syncSemanticForm({
  catalog,
  existingForm,
  seedComments: false,
});

const product = compileSchemaProjection({
  form,
  operation: {
    name: "read_recent_activity",
    schemaObjects: ["activity_events"],
  },
  sql: "SELECT event_seq, content_text FROM activity_events ORDER BY event_seq DESC LIMIT ?",
});

const preSqlProduct = compileSchemaProjection({
  form,
  requestText: "What appointments do I have coming up?",
  routing: { limit: 3, minimumScore: 3 },
});
```

MariaDB applications can pass their existing query executor, so the package does not need to own a pool:

```js
import { extractMariaDbCatalog } from "schema-semantic-compiler/mariadb";

const catalog = await extractMariaDbCatalog({
  databaseName: "tlom",
  schemaVersion: 12,
  query: pool.query.bind(pool),
});
```

## Migration integration

The recommended project workflow is:

```text
Backup database
    ↓
Apply versioned migration
    ↓
Run engine-specific integrity checks
    ↓
Synchronize db/schema-semantics.json
    ↓
Review mechanical changes and fill new semantic blanks
    ↓
Run consumer-specific projection tests
```

SQLite can wrap most schema migrations in a transaction. MariaDB DDL has different implicit-commit and rollback behavior, so the two projects can share one operator-facing workflow without pretending the engines provide identical transactional guarantees.

## Architecture boundary

Schema Semantic Compiler is read-and-explain-only.

It does not:

- Read variable-sized application datasets
- Return application rows
- Generate or rewrite SQL
- Determine whether SQL is safe
- Authorize users or operations
- Execute SQL
- Replace an application's MCP or database access policy
- Use an LLM

For a direct SQLite agent, projections can explain actual tables and views. For an MCP server, projections can explain only the public semantic entities and selected result fields rather than leaking private implementation details. The host decides which schema objects belong in its public form.

## Testing

```bash
npm test
npm run check
```

The current suite covers:

- Single-form comment bootstrap
- Preservation of human semantics across schema changes
- Retired object and field handling
- Comment-independent schema fingerprints
- SQL and operation-driven projections
- Version-1 form upgrades to `schemaObjects`
- Derived-view field inheritance without duplicate source projections
- Observable product identity and trace metadata
- SQLite introspection
- MariaDB `information_schema` normalization

## Status

Version `0.2.0` introduces form and projection contract version 2: `schemaObjects`, explicit derived-object lineage, and field semantic inheritance. Version `0.2.1` makes compiled products concise by omitting blank values recursively while retaining meaningful `false` and `0` values. Version-1 forms are upgraded deterministically during synchronization or projection. The JSON contracts are versioned public interfaces, and the SQL reference analyzer remains intentionally conservative; applications can always supply explicit operation schema objects when exact relevance matters.
