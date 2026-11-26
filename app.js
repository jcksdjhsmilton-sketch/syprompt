if (window.top !== window) { document.documentElement.textContent = ''; throw new Error('Iframe bloqueado'); }
const $ = s => document.querySelector(s);
const API = 'https://api.groq.com/openai/v1';
const FALLBACK_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'];
const MAX_STEPS = 8;

const store = {
  get(k, d, s = localStorage) { try { const v = s.getItem('sy_' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v, s = localStorage) { try { s.setItem('sy_' + k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k, s = localStorage) { try { s.removeItem('sy_' + k); } catch {} }
};

// Abas
function openTab(id) {
  document.querySelectorAll('section').forEach(s => s.classList.toggle('on', s.id === id));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === id));
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => openTab(b.dataset.tab));

// Célula do system prompt
let activePrompt = store.get('prompt', window.DEFAULT_SYSTEM_PROMPT);
$('#sys').value = activePrompt;
function promptState() {
  const v = $('#sys').value;
  $('#pstate').textContent = v !== activePrompt ? 'não aplicado' : activePrompt === window.DEFAULT_SYSTEM_PROMPT ? 'padrão' : 'personalizado';
  $('#pcount').textContent = `${v.length} caracteres (~${Math.ceil(v.length / 4)} tokens)`;
}
function applyPrompt() {
  activePrompt = $('#sys').value;
  if (activePrompt === window.DEFAULT_SYSTEM_PROMPT) store.del('prompt'); else store.set('prompt', activePrompt);
  promptState();
}
$('#sys').oninput = promptState;
$('#psave').onclick = applyPrompt;
$('#preset').onclick = () => { if (confirm('Substituir pelo prompt padrão?')) { $('#sys').value = window.DEFAULT_SYSTEM_PROMPT; applyPrompt(); } };
$('#pexport').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([$('#sys').value], { type: 'text/plain' }));
  a.download = 'system-prompt.txt'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('#pimport').onchange = async e => { const f = e.target.files[0]; if (f) { $('#sys').value = await f.text(); promptState(); } e.target.value = ''; };
promptState();

// Configurações
const cfg = Object.assign({ model: FALLBACK_MODELS[0], temp: 0.7, maxtok: 2048, effort: 'medium', maxchars: 6000, confirmnet: true }, store.get('cfg', {}));
function fillModels(ids) {
  if (!ids.includes(cfg.model)) cfg.model = ids[0];
  $('#model').replaceChildren(...ids.map(id => new Option(id, id)));
  $('#model').value = cfg.model;
}
fillModels(FALLBACK_MODELS.includes(cfg.model) ? FALLBACK_MODELS : [cfg.model, ...FALLBACK_MODELS]);
for (const k of ['temp', 'maxtok', 'effort', 'maxchars']) $('#' + k).value = cfg[k];
$('#confirmnet').checked = cfg.confirmnet;
$('#tout').textContent = cfg.temp;
function saveCfg() {
  cfg.model = $('#model').value; cfg.effort = $('#effort').value;
  cfg.temp = +$('#temp').value; $('#tout').textContent = cfg.temp;
  cfg.maxtok = Math.min(32768, Math.max(256, +$('#maxtok').value || 2048));
  cfg.maxchars = Math.min(40000, Math.max(1000, +$('#maxchars').value || 6000));
  cfg.confirmnet = $('#confirmnet').checked;
  store.set('cfg', cfg);
}
['model', 'temp', 'maxtok', 'effort', 'maxchars', 'confirmnet'].forEach(k => $('#' + k).addEventListener('input', saveCfg));

// Chaves: sessão por padrão; localStorage apenas se o usuário marcar
const saved = store.get('keys', null);
const keys = saved || store.get('keys', {}, sessionStorage);
$('#key').value = keys.groq || ''; $('#jina').value = keys.jina || ''; $('#remember').checked = !!saved || !keys.groq;
function saveKeys() {
  const k = { groq: $('#key').value.trim(), jina: $('#jina').value.trim() };
  store.del('keys'); store.del('keys', sessionStorage);
  store.set('keys', k, $('#remember').checked ? localStorage : sessionStorage);
}
['key', 'jina', 'remember'].forEach(k => $('#' + k).addEventListener('input', saveKeys));

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('Cancelado', 'AbortError')); }, { once: true });
});

async function groqFetch(path, body, signal) {
  const key = $('#key').value.trim();
  if (!key) throw new Error('Informe a chave da API Groq na aba Config.');
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(API + path, {
      method: body ? 'POST' : 'GET', signal,
      headers: { Authorization: 'Bearer ' + key, ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) return data;
    const wait = +r.headers.get('retry-after') || 5;
    if (r.status === 429 && attempt < 2 && wait <= 60) { await sleep(wait * 1000, signal); continue; }
    if (data.error?.code === 'tool_use_failed' && attempt < 2) continue;
    throw new Error(`Groq ${r.status}: ${data.error?.message || r.statusText}`);
  }
}

$('#loadmodels').onclick = async () => {
  try {
    const d = await groqFetch('/models');
    const ids = d.data.filter(m => m.active !== false && !/whisper|tts|orpheus|guard/i.test(m.id)).map(m => m.id).sort();
    if (!ids.length) throw new Error('Nenhum modelo retornado');
    fillModels(ids); saveCfg();
    $('#cstatus').textContent = ids.length + ' modelos carregados.';
  } catch (e) { $('#cstatus').textContent = e.message; }
};

// Lista de ferramentas
const enabled = new Set(store.get('tools', ['web_search', 'scrape_page', 'run_javascript', 'rag_search', 'current_time']).filter(n => Object.hasOwn(TOOLS, n)));
function renderTools() {
  $('#toollist').replaceChildren(...Object.entries(TOOLS).map(([name, t]) => {
    const label = document.createElement('label'); label.className = 'tool';
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = enabled.has(name);
    box.onchange = () => { box.checked ? enabled.add(name) : enabled.delete(name); store.set('tools', [...enabled]); };
    const text = document.createElement('div');
    const title = document.createElement('b'); title.textContent = `${t.group} · ${name}`;
    const desc = document.createElement('small'); desc.textContent = t.description;
    text.append(title, document.createElement('br'), desc); label.append(box, text);
    return label;
  }));
}
$('#allon').onclick = () => { Object.keys(TOOLS).forEach(n => enabled.add(n)); store.set('tools', [...enabled]); renderTools(); };
$('#alloff').onclick = () => { enabled.clear(); store.set('tools', []); renderTools(); };
renderTools();

// RAG
function renderDocs() {
  $('#doclist').replaceChildren(...Object.entries(RAG.list()).map(([src, n]) => {
    const li = document.createElement('li'); const s = document.createElement('span'); s.textContent = `${src} (${n} trechos)`;
    const b = document.createElement('button'); b.textContent = 'Remover'; b.onclick = () => { RAG.remove(src); renderDocs(); };
    li.append(s, b); return li;
  }));
}
$('#files').onchange = async e => {
  for (const f of e.target.files) {
    if (f.size > 2e6) { $('#ragstatus').textContent = f.name + ': limite de 2 MB.'; continue; }
    $('#ragstatus').textContent = `${f.name}: ${RAG.add(f.name, await f.text())} trechos.`;
  }
  e.target.value = ''; renderDocs();
};
$('#ragclear').onclick = () => { if (confirm('Apagar toda a base?')) { RAG.clear(); renderDocs(); } };
$('#ragadd').onclick = async () => {
  const url = $('#ragurl').value.trim(); if (!url) return;
  $('#ragstatus').textContent = 'Lendo...';
  try {
    const text = await TOOLS.scrape_page.run({ url }, { jinaKey: $('#jina').value.trim() });
    $('#ragstatus').textContent = `Indexados ${RAG.add(url, text.slice(0, 500000))} trechos.`; renderDocs();
  } catch (e) { $('#ragstatus').textContent = e.message; }
};
const ragReady = RAG.init().then(renderDocs);

// Chat
let history = [], controller = null;

function bubble(cls, text = '') {
  const d = document.createElement('div'); d.className = 'm ' + cls;
  // Markdown mínimo: só blocos de código, sempre via textContent (sem innerHTML)
  text.split('```').forEach((part, i) => {
    if (i % 2) {
      const pre = document.createElement('pre'), code = document.createElement('code');
      code.textContent = part.replace(/^[\w+#.-]*\n/, ''); pre.append(code); d.append(pre);
    } else d.append(part);
  });
  $('#log').append(d); $('#log').scrollTop = $('#log').scrollHeight;
  return d;
}
function toolBox(name, args) {
  const d = document.createElement('details'), s = document.createElement('summary'), p = document.createElement('pre');
  s.textContent = '⚙ ' + name; p.textContent = args; d.append(s, p); $('#log').append(d); $('#log').scrollTop = $('#log').scrollHeight;
  return t => p.textContent += '\n\n→ ' + t;
}

async function runTool(call, allowed, signal) {
  const { name, arguments: raw } = call.function;
  const show = toolBox(name, raw);
  let out;
  try {
    if (!allowed.includes(name)) throw new Error('Ferramenta desativada ou inexistente');
    const args = JSON.parse(raw || '{}'), tool = TOOLS[name];
    if (tool.net && cfg.confirmnet && !confirm(`Permitir ${name}?\n${raw.slice(0, 800)}`)) throw new Error('Negado pelo usuário');
    const result = await tool.run(args, {
      signal, jinaKey: $('#jina').value.trim(), confirm: m => confirm(m),
      groq: body => groqFetch('/chat/completions', body, signal)
    });
    out = typeof result === 'string' ? result : JSON.stringify(result);
  } catch (e) {
    if (signal.aborted) throw e;
    out = 'ERRO: ' + e.message;
  }
  out = String(out ?? '');
  if (out.length > cfg.maxchars) out = out.slice(0, cfg.maxchars) + `\n[cortado: ${out.length} caracteres no total]`;
  show(out);
  return out;
}

// Mantém turnos inteiros para não separar tool_calls das respostas
function trimHistory(msgs, limit = 16000) {
  const starts = msgs.map((m, i) => m.role === 'user' ? i : -1).filter(i => i >= 0);
  for (const i of starts) if (JSON.stringify(msgs.slice(i)).length <= limit) return msgs.slice(i);
  return msgs.slice(starts.at(-1));
}

async function agent(signal, turn) {
  const allowed = [...enabled];
  const tools = allowed.map(name => ({ type: 'function', function: { name, description: TOOLS[name].description, parameters: { type: 'object', properties: TOOLS[name].props, required: TOOLS[name].required } } }));
  const system = activePrompt.trim() ? [{ role: 'system', content: activePrompt }] : [];
  const past = trimHistory([...history, turn[0]]).slice(0, -1);
  for (let step = 0; step <= MAX_STEPS; step++) {
    const body = { model: cfg.model, temperature: cfg.temp, max_completion_tokens: cfg.maxtok, messages: [...system, ...past, ...turn] };
    if (/gpt-oss/.test(cfg.model) && !/safeguard/.test(cfg.model)) body.reasoning_effort = cfg.effort;
    if (tools.length) { body.tools = tools; body.tool_choice = step === MAX_STEPS ? 'none' : 'auto'; }
    const data = await groqFetch('/chat/completions', body, signal);
    const m = data.choices[0].message;
    const clean = { role: 'assistant', content: m.content || '' };
    if (m.tool_calls?.length) clean.tool_calls = m.tool_calls;
    turn.push(clean);
    if (m.content) bubble('assistant', m.content);
    if (!clean.tool_calls) { if (!m.content) bubble('error', 'Resposta vazia. Aumente "Máx. tokens" na Config.'); return; }
    for (const call of clean.tool_calls) turn.push({ role: 'tool', tool_call_id: call.id, content: await runTool(call, allowed, signal) });
  }
}

$('#form').onsubmit = async e => {
  e.preventDefault();
  const text = $('#msg').value.trim();
  if (!text || controller) return;
  controller = new AbortController();
  $('#send').disabled = $('#clear').disabled = true; $('#stop').disabled = false;
  $('#msg').value = ''; bubble('user', text);
  const turn = [{ role: 'user', content: text }];
  try { await ragReady; await agent(controller.signal, turn); history.push(...turn); }
  catch (err) {
    bubble('error', err.name === 'AbortError' ? 'Interrompido.' : err.message);
    $('#msg').value = text;
  } finally {
    controller = null; $('#send').disabled = $('#clear').disabled = false; $('#stop').disabled = true;
  }
};
$('#msg').onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#form').requestSubmit(); } };
$('#stop').onclick = () => controller?.abort();
$('#clear').onclick = () => { history = []; $('#log').replaceChildren(); };
