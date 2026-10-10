import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Every write goes through the operations layer (AGENTS.md), so it is
// validated, logged with provenance, and undoable. This rule is the
// tripwire for code that writes around it: a drizzle insert/update/delete/
// execute called on a database handle. It relies on the house convention
// that handles are named `db` or `tx` (or come straight from getDb()), so
// it's a guard against accidents, not a proof — review still matters.
const directWriteMessage =
  "Write through an operation (src/operations) so the change is logged and undoable — not directly on the database.";
const writeMethods = "/^(insert|update|delete|execute)$/";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      // The layer itself: tracked writes, the runtime and its command log.
      "src/operations/tracked.ts",
      "src/operations/runtime.ts",
      // Infrastructure rather than ledger data: sessions, passkeys and
      // WebAuthn challenges aren't user-visible changes worth undoing.
      "src/lib/auth/**",
      // Connector credentials and sync bookkeeping (connections, sync_runs).
      // The ledger data a sync brings in still goes through the import
      // operation.
      "src/lib/connectors/**",
      "src/lib/sync/**",
      // The model call log (content-free bookkeeping, like sync_runs).
      "src/lib/model/**",
      // Synthetic data loading, and tests setting up fixtures.
      "src/lib/seed/**",
      "src/lib/test-utils/**",
      "src/**/*.test.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `CallExpression[callee.property.name=${writeMethods}][callee.object.name=/^(db|tx)$/]`,
          message: directWriteMessage,
        },
        {
          // ctx.db inside an operation handler: reads only; writes go
          // through ctx.insert / ctx.update / ctx.remove so they're tracked.
          selector: `CallExpression[callee.property.name=${writeMethods}][callee.object.property.name=/^(db|tx)$/]`,
          message: directWriteMessage,
        },
        {
          selector: `CallExpression[callee.property.name=${writeMethods}][callee.object.callee.name='getDb']`,
          message: directWriteMessage,
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
