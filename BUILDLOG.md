# Build Log

- AI fixed the subscription status constraint to a partial index and aligned the ai_tokens type naming in the migration.
- AI initially used the `uuid` npm package; I caught that it ships as ESM-only, which breaks Jest under CommonJS. Replaced with Node's built-in `crypto.randomUUID()` — zero dependencies, same result.
- Resolved a local dev environment port conflict between a native Postgres service and the Docker container (both on 5432); moved container to port 5434 and fixed a malformed .env file where two variables had merged onto one line due to a missing newline.
