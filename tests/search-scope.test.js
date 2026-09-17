import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { initSchema, searchDocuments } from '../src/db.js';

test('FTS scopes project and type before applying the limit', () => {
  const db = new Database(':memory:'); initSchema(db);
  const add = db.prepare('INSERT INTO documents (id,title,content,doc_type) VALUES (?,?,?,?)');
  const vault = db.prepare('INSERT INTO vault_files (vault_path,content_hash,document_id,project) VALUES (?,?,?,?)');
  for (const [id, project, type] of [[1,'alpha','md'],[2,'beta','md'],[3,'alpha','pdf']]) {
    add.run(id,'Contrato editor Flutter','Validar formularios antes de publicar',type);
    vault.run(`${id}.md`,'hash',id,project);
  }
  assert.deepEqual(searchDocuments('editor',1,{db,project:'beta',type:'md'}).map(x=>x.id),[2]);
  assert.deepEqual(searchDocuments('editor',10,{db,project:'missing'}),[]);
  assert.deepEqual(searchDocuments('de',10,{db,project:'beta'}).map(x=>x.id),[2]);
  db.close();
});

test('natural-language Spanish queries retrieve relevant notes without requiring every term', () => {
  const db = new Database(':memory:'); initSchema(db);
  const add = db.prepare('INSERT INTO documents (id,title,content,doc_type) VALUES (?,?,?,?)');
  add.run(1,'Contrato editor Flutter','Pruebas de formularios móviles','md');
  add.run(2,'Comentario general','comprobar compatibilidad editor de formularios con la aplicación Flutter','md');
  const found = searchDocuments('comprobar compatibilidad editor de formularios con la aplicación Flutter',2,{db});
  assert.equal(found[0].id,1);
  assert.deepEqual(searchDocuments('   ',10,{db}),[]);
  db.close();
});
