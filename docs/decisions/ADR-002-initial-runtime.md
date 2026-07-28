# ADR-002: Initial lightweight runtime

- Status: Accepted
- Date: 2026-07-28

Use one Node.js 22/Fastify process, SQLite WAL, and a bounded in-process upstream semaphore. Do not add Redis, PostgreSQL, Elasticsearch, or a vector database until VPS measurements justify them.

SQLite uses foreign keys, busy timeout, short transactions, and forward-only migrations. Release directories are immutable and named by full Git SHA. systemd provides a non-root identity, resource envelope, restart backoff, and hardening.