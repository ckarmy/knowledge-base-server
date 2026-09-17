import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema } from '../src/db.js';
import { chunksFor, refreshVaultEmbeddings } from '../src/embeddings/refresh.js';

function fixture() {
  const db = new Database(':memory:');
  initSchema(db);
  db.prepare(`INSERT INTO documents (id,title,content,doc_type) VALUES (1,'Nota',?,'note')`)
    .run('Inicio. '.repeat(500) + ' INFORMACION AL FINAL');
  db.prepare(`INSERT INTO vault_files (vault_path,content_hash,document_id) VALUES ('nota.md','hash',1)`).run();
  return db;
}
const generate = async () => new Float32Array([1, 0, 0]);

test('chunks cover the full body including the tail', () => {
  const text = 'abcdefghij'.repeat(501);
  const chunks = chunksFor(text);
  assert.equal(chunks[0] + chunks.slice(1).map(s => s.slice(160)).join(''), text);
  assert.throws(() => chunksFor('text', 10, 10));
});

test('backfills unchanged notes, stays idempotent and invalidates modified content', async () => {
  const db = fixture();
  try {
    const first = await refreshVaultEmbeddings({ db, generate });
    assert.equal(first.refreshed, 1);
    assert.ok(first.chunks > 1);
    const last = db.prepare('SELECT chunk_text FROM embeddings ORDER BY chunk_index DESC LIMIT 1').get();
    assert.ok(last.chunk_text.endsWith(' INFORMACION AL FINAL'));
    const second = await refreshVaultEmbeddings({ db, generate: async () => { throw Error('Must not regenerate'); } });
    assert.equal(second.unchanged, 1);
    assert.deepEqual(second.errors, []);
    db.prepare('UPDATE documents SET content=? WHERE id=1').run('Nota cambiada');
    assert.equal(db.prepare('SELECT count(*) n FROM embeddings').get().n, 0);
    assert.equal((await refreshVaultEmbeddings({ db, generate })).refreshed, 1);
    db.prepare('DELETE FROM documents WHERE id=1').run();
    assert.equal(db.prepare('SELECT count(*) n FROM embeddings').get().n, 0);
  } finally { db.close(); }
});

test('generation failure retains previous valid vectors, and retry recovers', async () => {
  const db = fixture();
  try {
    await refreshVaultEmbeddings({ db, generate });
    const n = db.prepare('SELECT count(*) n FROM embeddings').get().n;
    const result = await refreshVaultEmbeddings({ db, force: true, generate: async () => { throw Error('Offline'); } });
    assert.equal(result.errors.length, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM embeddings').get().n, n);
    assert.equal((await refreshVaultEmbeddings({ db, generate, force: true })).refreshed, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM embeddings').get().n, n);
  } finally { db.close(); }
});

test('a concurrent edit cannot publish vectors for obsolete text', async () => {
  const db = fixture();
  try {
    const result = await refreshVaultEmbeddings({ db, generate: async () => {
      db.prepare('UPDATE documents SET content=? WHERE id=1').run('Edicion simultanea');
      return new Float32Array([1, 0]);
    } });
    assert.match(result.errors[0].message, /changed/);
    assert.equal(db.prepare('SELECT count(*) n FROM embeddings').get().n, 0);
  } finally { db.close(); }
});

test('Unicode boundaries never split emoji surrogate pairs', () => {
  for (const text of ['a'.repeat(1199) + '😀' + 'b'.repeat(1500), 'a'.repeat(1039) + '😀' + 'b'.repeat(1500)]) {
    const chunks = chunksFor(text);
    assert.ok(chunks.every(x => x.isWellFormed()));
    assert.ok(chunks.some(x => x.includes('😀')));
  }
  assert.ok(chunksFor('😀', 1, 0).every(x => x.isWellFormed()));
});
