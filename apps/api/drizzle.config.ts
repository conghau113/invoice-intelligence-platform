import { defineConfig } from 'drizzle-kit';

// `db:generate` only diffs schema.ts against ./drizzle; it needs no database connection.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
