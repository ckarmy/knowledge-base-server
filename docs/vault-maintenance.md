# Incremental Vault indexing

`kb vault reindex` indexes Markdown and maintains semantic embeddings by default.
`--text-only` skips embeddings for offline or low-resource maintenance; the next
normal run backfills unchanged notes too. Hidden directories and AGENTS/CLAUDE
instructions are excluded. Imported attachments remain independent documents.

Embedding state records the content hash, model version and chunk count. Full note
bodies are chunked with overlap. Failed generation leaves existing valid vectors
intact and exits with an error; retry resumes without recomputing current notes.
Content changes and deletion invalidate obsolete vectors. Concurrent edits are
checked again before publishing each note's vectors.

Hybrid search combines keyword and semantic ranks, deduplicates documents, ignores
common English/Spanish query words and applies project/type filters to both paths.
Representative retrieval checks supplement unit tests; ranking is not a guarantee
that every natural-language question returns the intended note first.

Long-running MCP processes must reload after a code update. New MCP sessions load
the updated code; existing sessions immediately see the updated SQLite index but
keep their already imported ranking implementation until reconnection.

Validation: `node --test tests/db.test.js tests/vault-parser.test.js tests/vault-indexer.test.js tests/vault-embeddings.test.js tests/search-ranking.test.js tests/search-scope.test.js`.
