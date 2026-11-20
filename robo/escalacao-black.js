// Escalacao final da Black (ORGANIZACAO - TIMES PARA A BLACK.xlsx) -> competicao_times, direto no banco (20/11/2026).
// Mesma regra do Admin (processarPlanilhaCompeticao): substitui a escalacao dos turnos que o arquivo traz (1o e 2o); ADM (os lideres) fica.
// Uso (na pasta robo): node escalacao-black.js [arquivo.xlsx]            (so analisa e escreve o relatorio, NAO grava)
//                      node escalacao-black.js [arquivo.xlsx] --gravar   (faz backup, apaga os turnos 1 e 2 e grava; volta tudo se der erro)
// Colunas do arquivo (aba Plan1): Turno (1/2), Tipo de atividade, Colaborador, Localizacao, Meta estabelecida, Lider responsavel, Cor.
// Usuario WMS: o do cadastro anterior; senao o palpite da Base de Ativos; senao NOME.SOBRENOME (SEMWMS.x se ja existir no WMS). Pendencias em C:/Entrega de Arquivos.
const fs = require('fs'), path = require('path');
const R = __dirname;   // pasta robo (node_modules e .env)
const XLSX = require(R + '/node_modules/xlsx');
const { createClient } = require(R + '/node_modules/@supabase/supabase-js');
const GRAVAR = process.argv.includes('--gravar');
const ARQ = process.argv.find(a => /\.xlsx$/i.test(a)) || 'C:/Leitura de Arquivos/ORGANIZAÇÃO - TIMES PARA A BLACK.xlsx';
const SAIDA = 'C:/Entrega de Arquivos';
const env = {}; fs.readFileSync(R + '/.env', 'utf8').split(/\r?\n/).forEach(l => { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) env[m[1]] = m[2].trim(); });
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const CONEC = ['DA', 'DE', 'DO', 'DAS', 'DOS', 'E'];
const toks = s => norm(s).split(' ').filter(t => t && CONEC.indexOf(t) === -1);
const TIME_DA_COR = { VERMELHO: 1, AZUL: 2, VERDE: 3, AMARELO: 4, ROSA: 5, ROXO: 6, LARANJA: 7, BRANCO: 8 };
const TURNO = { 1: '1º Turno', 2: '2º Turno' };

(async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'tv.html'), 'utf8');
  const key = /sb_publishable_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_.-]{80,}/.exec(html)[0];
  const sb = createClient('https://vehfchdfbukrbcedciiy.supabase.co', key);
  const a = await sb.auth.signInWithPassword({ email: env.PROD_EMAIL, password: env.PROD_SENHA });
  if (a.error) throw new Error('login: ' + a.error.message);

  // ---- dados do banco ----
  const base = (await sb.from('base_ativos').select('*')).data || [];
  const cad = (await sb.from('competicao_times').select('*')).data || [];
  const snap = ((await sb.from('dashboard_snapshots').select('dados').eq('pagina', 'outbound').maybeSingle()).data || {}).dados || {};
  const vistos = new Set();
  [['separacao', 'checkoutDia'], ['separacao', 'colmeiaDia'], ['conferencia', 'confCheckoutDia'], ['conferencia', 'confColmeiaUnitDia']].forEach(([p, k]) => {
    (((snap[p] || {})[k]) || []).forEach(x => Object.keys(x.itens || {}).forEach(u => vistos.add(String(u).toUpperCase())));
  });
  // base por nome (a carga mais recente manda)
  const porNome = new Map();
  base.slice().sort((x, y) => String(x.atualizado_em).localeCompare(String(y.atualizado_em))).forEach(b => porNome.set(norm(b.nome), b));
  const lista = Array.from(porNome.values());
  function acharBase(nome) {
    const n = norm(nome); if (porNome.has(n)) return { b: porNome.get(n), como: 'nome' };
    const t = toks(nome); if (t.length < 2) return null;
    const c = lista.filter(b => { const u = toks(b.nome); return u.length >= 2 && u[0] === t[0] && u[u.length - 1] === t[t.length - 1]; });
    if (c.length === 1) return { b: c[0], como: 'primeiro+ultimo' };
    const c2 = lista.filter(b => { const u = toks(b.nome); return u[0] === t[0] && t.slice(1).every(x => u.indexOf(x) !== -1); });
    return c2.length === 1 ? { b: c2[0], como: 'tokens' } : null;
  }
  const cadPorNome = new Map();   // nome normalizado -> usuario real ja no cadastro (sem REFORCO/SEMWMS)
  cad.forEach(r => { if (r.nome && !/^(REFORCO|SEMWMS)\./.test(r.usuario_wms)) cadPorNome.set(norm(r.nome), r.usuario_wms); });

  // ---- planilha ----
  const wb = XLSX.readFile(ARQ), ws = wb.Sheets['Plan1'];
  const linhas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }).slice(1).filter(r => r[2]);
  const registros = [], rel = { total: linhas.length, doCadastro: 0, baseVisto: 0, baseNaoVisto: 0, foraBase: 0, colisao: 0 }, pend = [];
  const usadoPor = new Map();   // usuario|turno -> nome normalizado (para detectar homonimos)
  linhas.forEach(r => {
    const turno = TURNO[Number(r[0])], tipo = norm(r[1]), nome = String(r[2]).replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim(), loc = norm(r[3]), cor = norm(r[6]), time = TIME_DA_COR[cor];
    if (!turno || !time) throw new Error('linha invalida: ' + JSON.stringify(r.slice(0, 7)));
    const atividades = tipo.startsWith('SEPARA') ? ['sep'] : tipo.startsWith('FATUR') ? ['conf'] : tipo.startsWith('EMBAL') ? ['emb'] : tipo.startsWith('ORGANIZ') ? ['org'] : tipo.startsWith('COLMEIA') ? ['sep', 'conf'] : null;
    if (!atividades) throw new Error('atividade desconhecida: ' + tipo);
    const mp = /(\d)\s*(?:O|º)?\s*PISO/.exec(loc), piso = mp ? Number(mp[1]) : /CONFECC/.test(loc) ? 1 : null;
    const ab = acharBase(nome), nn = norm(nome);
    let usuario, origem;
    if (cadPorNome.has(nn)) { usuario = cadPorNome.get(nn); origem = 'cadastro'; rel.doCadastro++; }
    else if (ab && ab.b.usuario_wms) {
      usuario = String(ab.b.usuario_wms).toUpperCase();
      if (vistos.has(usuario)) { origem = 'base+visto'; rel.baseVisto++; } else { origem = 'base (nao visto no WMS)'; rel.baseNaoVisto++; pend.push([nome, usuario, TURNO[Number(r[0])], cor, 'usuario palpite da Base de Ativos; nunca apareceu na producao do WMS']); }
    } else {
      const t = toks(nome), pal = (t.length > 1 ? t[0] + '.' + t[t.length - 1] : t[0] || 'SEM.NOME'); rel.foraBase++;
      if (vistos.has(pal)) { usuario = 'SEMWMS.' + pal; pend.push([nome, usuario, TURNO[Number(r[0])], cor, 'fora da Base de Ativos e ' + pal + ' ja existe no WMS (pode ser outra pessoa): deixei provisorio SEMWMS']); rel.semwms = (rel.semwms || 0) + 1; }
      else { usuario = pal; pend.push([nome, usuario, TURNO[Number(r[0])], cor, 'fora da Base de Ativos; usuario montado pelo nome (confirmar quando criarem o login)']); }
      origem = 'fora da base';
    }
    const kk = usuario + '|' + turno;
    if (usadoPor.has(kk) && usadoPor.get(kk) !== nn) { rel.colisao++; pend.push([nome, usuario, TURNO[Number(r[0])], cor, 'MESMO usuario de outra pessoa no turno (homonimo): ajustar']); }
    usadoPor.set(kk, nn);
    atividades.forEach(atividade => registros.push({ usuario_wms: usuario, nome: (ab ? ab.b.nome : nome.toUpperCase()), turno, atividade, setor: null, piso, time,
      observacao: tipo.startsWith('COLMEIA') ? 'Colmeia' : null, lider: false, presenca: {}, atualizado_em: new Date().toISOString() }));
  });
  // chaves repetidas (usuario|atividade|turno)
  const chaves = new Map(); let duplicadas = 0;
  registros.forEach(x => { const k = x.usuario_wms + '|' + x.atividade + '|' + x.turno; if (chaves.has(k)) duplicadas++; chaves.set(k, x); });
  console.log('linhas do arquivo:', rel.total, '| registros a gravar:', registros.length, '| chaves duplicadas:', duplicadas);
  console.log('usuario: cadastro', rel.doCadastro, '| base+visto', rel.baseVisto, '| base nao visto', rel.baseNaoVisto, '| fora da base', rel.foraBase, '| colisoes', rel.colisao, '| SEMWMS', rel.semwms || 0);
  const porTT = {}; registros.forEach(x => { const k = x.time + '|' + x.turno[0]; porTT[k] = (porTT[k] || 0) + 1; });
  console.log('registros por time|turno:', JSON.stringify(porTT));
  // relatorio de pendencias para o Nicolas (fica fora do Git)
  const tsv = ['Nome\tUsuario WMS usado\tTurno\tTime\tObservacao'].concat(pend.map(p => p.join('\t'))).join('\r\n');
  fs.writeFileSync(path.join(SAIDA, 'escalacao_pendencias_usuario_wms.tsv'), '\uFEFF' + tsv, 'utf8');
  console.log('pendencias (usuario a confirmar):', pend.length, '-> ' + SAIDA + '/escalacao_pendencias_usuario_wms.tsv');
  if (duplicadas) { console.log('ABORTA: ha chaves duplicadas'); process.exit(2); }
  if (!GRAVAR) return;

  // ---- grava (backup, apaga 1o e 2o turno, insere em lotes; volta tudo se falhar) ----
  const carimbo = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const arqBackup = path.join(SAIDA, 'backup_competicao_times_' + carimbo + '.json');
  fs.writeFileSync(arqBackup, JSON.stringify(cad));
  console.log('backup:', arqBackup, '(' + cad.length + ' linhas)');
  const turnos = ['1º Turno', '2º Turno'];
  const anterior = cad.filter(x => turnos.indexOf(x.turno) !== -1);
  const d = await sb.from('competicao_times').delete().in('turno', turnos);
  if (d.error) throw new Error('apagar: ' + d.error.message);
  for (let i = 0; i < registros.length; i += 200) {
    const ins = await sb.from('competicao_times').insert(registros.slice(i, i + 200));
    if (ins.error) {
      await sb.from('competicao_times').delete().in('turno', turnos);
      const volta = anterior.length ? await sb.from('competicao_times').insert(anterior) : { error: null };
      throw new Error('gravar: ' + ins.error.message + (volta.error ? ' | NAO VOLTOU: ' + volta.error.message : ' | escalacao anterior mantida'));
    }
  }
  const dep = (await sb.from('competicao_times').select('time,turno,atividade')).data || [];
  const c2 = {}; dep.forEach(x => { const k = x.time + '|' + x.turno[0]; c2[k] = (c2[k] || 0) + 1; });
  console.log('GRAVADO. total no banco:', dep.length, '| por time|turno:', JSON.stringify(c2));
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
