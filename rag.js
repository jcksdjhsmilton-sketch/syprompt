// RAG leve: chunks + BM25, persistido em IndexedDB, sem dependências.
const RAG = (() => {
  let chunks = [], db = null;
  const norm = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tokens = s => norm(s).match(/[a-z0-9_]+/g) || [];

  function split(text, size = 1200, overlap = 200) {
    const out = [];
    for (let i = 0; i < text.length;) {
      let end = Math.min(i + size, text.length);
      if (end < text.length) {
        const cut = text.lastIndexOf('\n', end);
        if (cut > i + size / 2) end = cut;
      }
      out.push(text.slice(i, end));
      if (end >= text.length) break;
      i = end - overlap;
    }
    return out;
  }

  function save() {
    if (!db) return;
    db.transaction('s', 'readwrite').objectStore('s').put(chunks, 'chunks');
  }

  function init() {
    return new Promise(res => {
      try {
        const req = indexedDB.open('syprompt', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('s');
        req.onerror = () => res();
        req.onsuccess = () => {
          db = req.result;
          const g = db.transaction('s').objectStore('s').get('chunks');
          g.onsuccess = () => { chunks = g.result || []; res(); };
          g.onerror = () => res();
        };
      } catch { res(); }
    });
  }

  function add(source, text) {
    chunks = chunks.filter(c => c.source !== source);
    const parts = split(text.trim()).filter(Boolean);
    parts.forEach((t, i) => chunks.push({ source, i, text: t, tk: tokens(t) }));
    save();
    return parts.length;
  }

  function search(query, k = 4) {
    const q = [...new Set(tokens(query))];
    const N = chunks.length;
    if (!N || !q.length) return [];
    const avg = chunks.reduce((a, c) => a + c.tk.length, 0) / N;
    const df = {};
    q.forEach(t => df[t] = chunks.filter(c => c.tk.includes(t)).length);
    return chunks.map(c => {
      let score = 0;
      for (const t of q) {
        const f = c.tk.reduce((n, x) => n + (x === t), 0);
        if (!f) continue;
        const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
        score += idf * f * 2.5 / (f + 1.5 * (0.25 + 0.75 * c.tk.length / avg));
      }
      return { source: c.source, chunk: c.i, score: +score.toFixed(3), text: c.text };
    }).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  }

  const list = () => chunks.reduce((m, c) => (m[c.source] = (m[c.source] || 0) + 1, m), Object.create(null));
  const remove = s => { chunks = chunks.filter(c => c.source !== s); save(); };
  const clear = () => { chunks = []; save(); };
  return { init, add, search, list, remove, clear };
})();
