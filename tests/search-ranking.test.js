import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSearchResults } from '../src/embeddings/search.js';

test('hybrid ranking preserves semantic-only scores and emits one result per document', () => {
  const results = mergeSearchResults([{ id: 1, rank: -3 }, { id: 2, rank: -2 }], [
    { document_id: 2, score: 0.8 }, { document_id: 3, score: 0.9 },
  ]);
  assert.deepEqual(results.map(r => r.id), [2, 1, 3]);
  assert.equal(results[2].semantic_score, 0.9);
  assert.equal(results[0].source, 'both');
});

test('lexical relevance survives when semantic candidates differ', () => {
  const results = mergeSearchResults([{ id: 1, rank: -50 }, { id: 2, rank: -2 }], [
    { document_id: 3, score: 0.8 }, { document_id: 4, score: 0.7 },
  ]);
  assert.ok(results.slice(0, 2).some(r => r.id === 1));
});
