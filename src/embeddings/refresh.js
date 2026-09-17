import { createHash } from 'node:crypto';
import { getDb } from '../db.js';
import { generateEmbedding, embeddingToBuffer } from './embed.js';

export const EMBEDDING_VERSION = 'Xenova/all-MiniLM-L6-v2:chars-1200-overlap-160:v1';

export function chunksFor(text, size = 1200, overlap = 160) {
  if (size < 1 || overlap < 0 || overlap >= size) throw new Error('Invalid chunk bounds');
  const chunks = [];
  for (let start = 0; start < text.length; start += size - overlap) {
    let begin = start;
    let end = Math.min(start + size, text.length);
    // Preserve complete UTF-16 surrogate pairs at both boundaries.
    if (begin > 0 && /[\uDC00-\uDFFF]/.test(text[begin]) && /[\uD800-\uDBFF]/.test(text[begin - 1])) begin--;
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end++;
    chunks.push(text.slice(begin, end));
    if (end === text.length) break;
  }
  return chunks;
}

export async function refreshVaultEmbeddings({ db = getDb(), generate = generateEmbedding,
  onProgress = () => {}, force = false } = {}) {
  const documents = db.prepare(`SELECT d.id, d.content, v.vault_path
    FROM documents d JOIN vault_files v ON v.document_id = d.id ORDER BY d.id`).all();
  const result = { documents: documents.length, refreshed: 0, unchanged: 0, chunks: 0, errors: [] };
  for (const doc of documents) {
    const hash = createHash('sha256').update(doc.content).digest('hex');
    const parts = chunksFor(doc.content);
    const state = db.prepare('SELECT * FROM vault_embedding_state WHERE document_id = ?').get(doc.id);
    const stored = db.prepare('SELECT chunk_text FROM embeddings WHERE document_id = ? ORDER BY chunk_index').all(doc.id);
    if (!force && state?.content_hash === hash && state.model === EMBEDDING_VERSION &&
        state.chunk_count === parts.length && stored.length === parts.length &&
        stored.every((row, index) => row.chunk_text === parts[index])) {
      result.unchanged++;
      continue;
    }
    try {
      // Generate first: a model failure cannot leave a document half-indexed.
      const vectors = [];
      for (const part of parts) {
        const vector = await generate(part);
        if (!vector.length || !Array.from(vector).every(Number.isFinite)) throw new Error('Invalid embedding');
        vectors.push(vector);
      }
      db.transaction(() => {
        if (db.prepare('SELECT content FROM documents WHERE id = ?').get(doc.id)?.content !== doc.content) {
          throw new Error('Document changed during embedding generation; retry');
        }
        db.prepare('DELETE FROM embeddings WHERE document_id = ?').run(doc.id);
        const insert = db.prepare(`INSERT INTO embeddings
          (document_id, vault_path, chunk_index, chunk_text, embedding, dimensions) VALUES (?, ?, ?, ?, ?, ?)`);
        for (let i = 0; i < parts.length; i++) {
          insert.run(doc.id, doc.vault_path, i, parts[i], embeddingToBuffer(vectors[i]), vectors[i].length);
        }
        db.prepare(`INSERT INTO vault_embedding_state (document_id, content_hash, model, chunk_count)
          VALUES (?, ?, ?, ?) ON CONFLICT(document_id) DO UPDATE SET
          content_hash=excluded.content_hash, model=excluded.model, chunk_count=excluded.chunk_count`)
          .run(doc.id, hash, EMBEDDING_VERSION, parts.length);
      })();
      result.refreshed++;
      result.chunks += parts.length;
      onProgress({ id: doc.id, refreshed: result.refreshed, total: documents.length });
    } catch (error) {
      result.errors.push({ id: doc.id, path: doc.vault_path, message: error.message });
      break; // Stop on model/storage failure; a subsequent run resumes from saved state.
    }
  }
  return result;
}
