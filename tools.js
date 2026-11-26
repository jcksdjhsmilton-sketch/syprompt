// Ferramentas executadas no navegador. Para criar outra: adicione um item em TOOLS.
const TOOLS = (() => {
  const S = d => ({ type: 'string', description: d });
  const enc = encodeURIComponent;

  function httpUrl(raw) {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol)) throw new Error('Apenas http/https');
    if (u.username || u.password) throw new Error('URL com credenciais não é permitida');
    if (u.origin === location.origin) throw new Error('Acesso ao próprio site bloqueado');
    return u.href;
  }

  async function req(url, opt = {}, signal) {
    const timeout = AbortSignal.timeout(45000);
    const r = await fetch(url, { ...opt, credentials: 'omit', referrerPolicy: 'no-referrer',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    return r;
  }
  async function getJSON(url, signal, opt) {
    const r = await req(url, opt, signal);
    if (!r.ok) throw new Error(`HTTP ${r.status} em ${new URL(url).hostname}`);
    return r.json();
  }

  async function reader(url, format, ctx) {
    const headers = {};
    if (format) headers['X-Return-Format'] = format;
    if (ctx.jinaKey) headers.Authorization = 'Bearer ' + ctx.jinaKey;
    const r = await req('https://r.jina.ai/' + httpUrl(url), { headers }, ctx.signal);
    if (!r.ok) throw new Error(`Jina Reader HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.text();
  }

  // Código roda num Worker dentro de iframe sem origem e com CSP que bloqueia rede.
  function runJS(code, signal) {
    return new Promise(resolve => {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.hidden = true;
      const worker = `onmessage=async e=>{const out=[];const s=v=>{try{return typeof v==='string'?v:JSON.stringify(v)??String(v)}catch{return String(v)}};console.log=console.error=console.warn=console.info=(...a)=>out.push(a.map(s).join(' '));try{const F=Object.getPrototypeOf(async()=>{}).constructor;const r=await new F(e.data)();postMessage({logs:out,result:r===undefined?null:s(r)})}catch(x){postMessage({logs:out,error:String(x)})}}`;
      const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:"><script>onmessage=e=>{if(e.source!==parent)return;const w=new Worker(URL.createObjectURL(new Blob([${JSON.stringify(worker)}])));w.onmessage=m=>parent.postMessage(m.data,'*');w.onerror=x=>parent.postMessage({error:x.message},'*');w.postMessage(e.data)};<\/script>`;
      const done = v => { clearTimeout(timer); removeEventListener('message', on); signal?.removeEventListener('abort', abort); frame.remove(); resolve(v); };
      const on = e => { if (e.source === frame.contentWindow) done(e.data); };
      const abort = () => done({ error: 'Cancelado' });
      const timer = setTimeout(() => done({ error: 'Timeout de 5s' }), 5000);
      addEventListener('message', on);
      signal?.addEventListener('abort', abort);
      frame.onload = () => frame.contentWindow.postMessage(code, '*');
      frame.srcdoc = html;
      document.body.append(frame);
    });
  }

  const b64e = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  const b64d = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

  const T = (group, net, description, props, required, run) => ({ group, net, description, props, required, run });

  return {
    web_search: T('Internet', true, 'Pesquisa na web em tempo real (browser_search do Groq) e retorna resumo com fontes.',
      { query: S('Consulta') }, ['query'], async ({ query }, ctx) => {
        const d = await ctx.groq({
          model: 'openai/gpt-oss-20b', reasoning_effort: 'low', max_completion_tokens: 2048,
          tool_choice: 'required', tools: [{ type: 'browser_search' }],
          messages: [{ role: 'user', content: 'Pesquise na web e responda de forma concisa, listando as URLs das fontes: ' + query }]
        });
        return d.choices[0].message.content;
      }),
    jina_search: T('Internet', true, 'Busca alternativa via s.jina.ai. Exige chave Jina.',
      { query: S('Consulta') }, ['query'], async ({ query }, ctx) => {
        if (!ctx.jinaKey) throw new Error('Configure a chave Jina na aba Config');
        const r = await req('https://s.jina.ai/?q=' + enc(query), { headers: { Authorization: 'Bearer ' + ctx.jinaKey, 'X-Respond-With': 'no-content' } }, ctx.signal);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }),
    wikipedia_search: T('Internet', true, 'Busca artigos na Wikipedia.',
      { query: S('Consulta'), lang: S('Idioma, ex: pt, en') }, ['query'], async ({ query, lang = 'pt' }, ctx) => {
        if (!/^[a-z-]{2,12}$/.test(lang)) throw new Error('Idioma inválido');
        const d = await getJSON(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srsearch=${enc(query)}`, ctx.signal);
        return d.query.search.map(x => ({ title: x.title, snippet: x.snippet.replace(/<[^>]+>/g, ''), url: `https://${lang}.wikipedia.org/wiki/${enc(x.title.replace(/ /g, '_'))}` }));
      }),

    scrape_page: T('Scraping', true, 'Lê uma página ou PDF e devolve o texto em Markdown.',
      { url: S('URL completa'), offset: { type: 'integer', description: 'Posição inicial para continuar a leitura' } }, ['url'],
      async ({ url, offset = 0 }, ctx) => (await reader(url, '', ctx)).slice(Math.max(0, offset))),
    scrape_select: T('Scraping', true, 'Extrai elementos de uma página por seletor CSS (texto, href, src).',
      { url: S('URL completa'), selector: S('Seletor CSS, ex: h2 a, table tr') }, ['url', 'selector'], async ({ url, selector }, ctx) => {
        const doc = new DOMParser().parseFromString(await reader(url, 'html', ctx), 'text/html');
        const all = [...doc.querySelectorAll(selector)];
        return { total: all.length, items: all.slice(0, 60).map(e => ({ tag: e.tagName.toLowerCase(), text: e.textContent.trim().slice(0, 300), href: e.getAttribute('href') || undefined, src: e.getAttribute('src') || undefined })) };
      }),
    page_inspect: T('Scraping', true, 'Analisa o HTML de uma página: título, meta tags, scripts, links e formulários.',
      { url: S('URL completa') }, ['url'], async ({ url }, ctx) => {
        const doc = new DOMParser().parseFromString(await reader(url, 'html', ctx), 'text/html');
        const q = (s, f) => [...doc.querySelectorAll(s)].slice(0, 40).map(f);
        return { title: doc.title,
          meta: q('meta[name],meta[property]', m => [m.getAttribute('name') || m.getAttribute('property'), m.getAttribute('content')]),
          scripts: q('script[src]', s => s.getAttribute('src')),
          links: q('a[href]', a => a.getAttribute('href')),
          forms: q('form', f => ({ action: f.getAttribute('action'), method: f.getAttribute('method'), fields: [...f.querySelectorAll('input,select,textarea')].map(i => i.getAttribute('name')) })) };
      }),

    http_request: T('DevTools', true, 'Faz requisição HTTP pelo navegador (sujeita a CORS). Retorna status, headers visíveis e corpo.',
      { url: S('URL'), method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] }, headers: { type: 'object' }, body: S('Corpo') }, ['url'],
      async ({ url, method = 'GET', headers, body }, ctx) => {
        method = method.toUpperCase();
        const target = httpUrl(url);
        if (!['GET', 'HEAD'].includes(method) || headers) {
          if (!ctx.confirm(`A IA quer enviar:\n${method} ${target}\nHeaders: ${JSON.stringify(headers || {})}\nBody: ${(body || '').slice(0, 500)}\n\nPermitir?`)) throw new Error('Negado pelo usuário');
        }
        const t = performance.now();
        const r = await req(target, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : body }, ctx.signal);
        return { status: r.status, ms: Math.round(performance.now() - t), url: r.url, headers: Object.fromEntries(r.headers), body: await r.text() };
      }),
    run_javascript: T('DevTools', false, 'Executa JavaScript isolado, sem rede, limite de 5s. Use return e console.log.',
      { code: S('Código (corpo de função async)') }, ['code'], ({ code }, ctx) => runJS(code, ctx.signal)),
    dns_lookup: T('DevTools', true, 'Consulta registros DNS via dns.google.',
      { name: S('Domínio'), type: S('A, AAAA, MX, TXT, NS, CNAME') }, ['name'],
      ({ name, type = 'A' }, ctx) => getJSON(`https://dns.google/resolve?name=${enc(name)}&type=${enc(type)}`, ctx.signal)),
    github_repo: T('DevTools', true, 'Lê dados de um repositório público do GitHub ou o conteúdo de um caminho.',
      { repo: S('dono/nome'), path: S('Arquivo ou pasta (opcional)') }, ['repo'], async ({ repo, path }, ctx) => {
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.includes('..')) throw new Error('Use dono/nome');
        if (path?.split('/').includes('..')) throw new Error('Caminho inválido');
        const d = await getJSON(`https://api.github.com/repos/${repo}` + (path !== undefined ? '/contents/' + path.split('/').map(enc).join('/') : ''), ctx.signal);
        if (Array.isArray(d)) return d.map(x => ({ name: x.name, type: x.type, path: x.path }));
        if (d.encoding === 'base64') return b64d(d.content.replace(/\n/g, ''));
        return { name: d.full_name, description: d.description, stars: d.stargazers_count, language: d.language, branch: d.default_branch, updated: d.pushed_at, url: d.html_url };
      }),
    package_info: T('DevTools', true, 'Versão e descrição de pacote no npm, PyPI ou crates.io.',
      { name: S('Pacote'), registry: { type: 'string', enum: ['npm', 'pypi', 'crates'] } }, ['name', 'registry'], async ({ name, registry }, ctx) => {
        if (registry === 'npm') { const d = await getJSON(`https://registry.npmjs.org/${enc(name)}/latest`, ctx.signal); return { version: d.version, description: d.description, dependencies: d.dependencies }; }
        if (registry === 'pypi') { const d = await getJSON(`https://pypi.org/pypi/${enc(name)}/json`, ctx.signal); return { version: d.info.version, summary: d.info.summary, requires: d.info.requires_dist }; }
        const d = await getJSON(`https://crates.io/api/v1/crates/${enc(name)}`, ctx.signal);
        return { version: d.crate.max_version, description: d.crate.description };
      }),
    codec: T('DevTools', false, 'Codifica/decodifica base64, url e hex, formata JSON ou decodifica JWT (sem validar assinatura).',
      { op: { type: 'string', enum: ['base64_encode', 'base64_decode', 'url_encode', 'url_decode', 'hex_encode', 'hex_decode', 'json_format', 'jwt_decode'] }, input: S('Entrada') }, ['op', 'input'],
      ({ op, input }) => ({
        base64_encode: () => b64e(input), base64_decode: () => b64d(input),
        url_encode: () => enc(input), url_decode: () => decodeURIComponent(input),
        hex_encode: () => hex(new TextEncoder().encode(input)),
        hex_decode: () => { const h = input.replace(/\s/g, ''); if (h.length % 2 || /[^0-9a-f]/i.test(h)) throw new Error('Hex inválido'); return new TextDecoder().decode(Uint8Array.from(h.match(/../g) || [], x => parseInt(x, 16))); },
        json_format: () => JSON.stringify(JSON.parse(input), null, 2),
        jwt_decode: () => input.split('.').slice(0, 2).map(p => JSON.parse(b64d(p)))
      })[op]()),
    hash_text: T('DevTools', false, 'Gera hash SHA do texto.',
      { text: S('Texto'), algorithm: { type: 'string', enum: ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] } }, ['text'],
      async ({ text, algorithm = 'SHA-256' }) => hex(await crypto.subtle.digest(algorithm, new TextEncoder().encode(text)))),
    current_time: T('DevTools', false, 'Data e hora atuais.', {}, [], () => ({ iso: new Date().toISOString(), local: new Date().toString() })),

    rag_search: T('RAG', false, 'Busca trechos na base de conhecimento do usuário.',
      { query: S('Termos de busca') }, ['query'], ({ query }) => { const r = RAG.search(query); return r.length ? r : 'Nada encontrado na base.'; }),
    rag_add_url: T('RAG', true, 'Lê uma URL e salva na base de conhecimento. Use só quando o usuário pedir.',
      { url: S('URL') }, ['url'], async ({ url }, ctx) => {
        if (!ctx.confirm('A IA quer salvar na base:\n' + url + '\n\nPermitir?')) throw new Error('Negado pelo usuário');
        return `Indexados ${RAG.add(url, await reader(url, '', ctx))} trechos`;
      })
  };
})();
