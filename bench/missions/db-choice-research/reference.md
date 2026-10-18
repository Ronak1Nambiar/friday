Reference answer, only used to check the checklist (bench --check).

Recommendation: DuckDB. It is embedded (in-process, no server), and its columnar, vectorized engine is built for analytic queries like hourly averages over months.

- SQLite: embedded, tiny, easy to bundle, but row-oriented; aggregates over 1M rows are fine but slower. WAL mode allows one writer with readers.
- PostgreSQL: a separate server process to install and manage alongside Electron: heavy to package.
- Packaging: DuckDB ships prebuilt native binaries; electron-rebuild may be needed.
- File size: DuckDB compresses columns, so storage on disk is smaller.
- Risks: DuckDB has a single writer per file and a younger ecosystem; that trade-off is acceptable here.
