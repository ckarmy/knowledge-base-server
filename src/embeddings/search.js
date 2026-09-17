import { generateEmbedding, cosineSimilarity, bufferToEmbedding } from './embed.js';
import { getDb } from '../db.js';

// Brute-force cosine similarity — works for <2000 notes.
// If vault exceeds 2000 notes, consider sqlite-vss extension for ANN search.
export async function semanticSearch(query, { limit = 10, project, type } = {}) {
  const queryEmbedding = await generateEmbedding(query);

  let sql = `
    SELECT e.document_id, e.vault_path, e.chunk_text, e.embedding,
           d.title, d.doc_type, d.tags
    FROM embeddings e
    JOIN documents d ON d.id = e.document_id
  `;
  const conditions = [];
  const params = [];

  if (project) {
    sql += ' JOIN vault_files vf ON vf.document_id = e.document_id';
    conditions.push('vf.project = ?');
    params.push(project);
  }
  if (type) {
    conditions.push('d.doc_type = ?');
    params.push(type);
  }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');

  const rows = getDb().prepare(sql).all(...params);

  const scored = rows.map(row => {
    const embedding = bufferToEmbedding(row.embedding);
    const score = cosineSimilarity(queryEmbedding, embedding);
    return {
      document_id: row.document_id,
      vault_path: row.vault_path,
      title: row.title,
      type: row.doc_type,
      tags: row.tags,
      chunk_preview: row.chunk_text?.slice(0, 200),
      score,
    };
  });

  // A long note may have many chunks; keep its best match, not many copies.
  const best = new Map();
  for (const item of scored) {
    if (!best.has(item.document_id) || best.get(item.document_id).score < item.score) {
      best.set(item.document_id, item);
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function hybridSearch(query, { limit = 10, project, type } = {}) {
  const { searchDocuments } = await import('../db.js');

  let ftsResults, semanticResults;
  try {
    [ftsResults, semanticResults] = await Promise.all([
      Promise.resolve(searchDocuments(query, limit * 2, { project, type })),
      semanticSearch(query, { limit: limit * 2, project, type }),
    ]);
  } catch {
    // If semantic search fails (no embeddings, model error, etc.), fall back to FTS only
    ftsResults = searchDocuments(query, limit * 2, { project, type });
    semanticResults = [];
  }

  return mergeSearchResults(ftsResults, semanticResults, limit);
}

export function mergeSearchResults(ftsResults, semanticResults, limit = 10) {
  const seen = new Map();

  for (const r of ftsResults) {
    seen.set(r.id, { ...r, fts_rank: r.rank || 0, semantic_score: 0, source: 'fts' });
  }
  for (const r of semanticResults) {
    if (seen.has(r.document_id)) {
      seen.get(r.document_id).semantic_score = r.score;
      seen.get(r.document_id).source = 'both';
    } else {
      seen.set(r.document_id, { id: r.document_id, title: r.title, ...r, fts_rank: 0,
        semantic_score: r.score, source: 'semantic' });
    }
  }

  // Reciprocal rank fusion combines two incomparable score scales and preserves lexical relevance.
  const ranks = new Map();
  for (const list of [ftsResults, semanticResults]) {
    const included = new Set();
    list.forEach((item, index) => {
      const id = item.id ?? item.document_id;
      if (!included.has(id)) ranks.set(id, (ranks.get(id) || 0) + 1 / (60 + index + 1));
      included.add(id);
    });
  }
  return [...seen.values()].map(item => ({ ...item, hybrid_score: ranks.get(item.id) || 0 }))
    .sort((a, b) => b.hybrid_score - a.hybrid_score || b.semantic_score - a.semantic_score)
    .slice(0, limit);
}
