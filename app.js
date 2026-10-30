import { CONFIG } from "./config.js";
const API = CONFIG.supabaseUrl.replace(/\/+$/, "");

// Todo conteúdo variável entra por textContent/value. Nunca interpretar HTML recebido.
const $ = id => document.getElementById(id);
const estado = { sessao: null, obras: [], vinculos: [], bms: [], bm: null, pedido: null, itens: [], ocupado: false };
const data = v => new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(new Date(v)).replaceAll("/", "-");
const moeda = v => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v));
function el(tag, texto, pai) { const n = document.createElement(tag); if (texto !== undefined) n.textContent = String(texto); if (pai) pai.append(n); return n; }
function aviso(texto) { $("mensagem").textContent = texto; }
function configurado() {
  if (CONFIG.supabaseUrl.startsWith("PREENCHER") || CONFIG.anonKey.startsWith("PREENCHER")) throw new Error("Ambiente ainda não configurado. A administração precisa preencher config.js.");
  const u = new URL(CONFIG.supabaseUrl);
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/" || !u.hostname.endsWith(".supabase.co")) throw new Error("Configuração de ambiente inválida.");
}
async function atualizarSessao() {
  if (!estado.sessao) throw new Error("Entre novamente.");
  if (Date.now() < estado.sessao.expira - 60000) return;
  const r = await fetch(`${API}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST", headers: { apikey: CONFIG.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: estado.sessao.refresh_token }), cache: "no-store"
  });
  if (!r.ok) { limparSessao(); throw new Error("Sessão expirada. Entre novamente."); }
  guardarSessao(await r.json());
}
function guardarSessao(s) {
  if (!s.access_token || !s.refresh_token) throw new Error("Sessão inválida.");
  // Apenas memória. Recarregar a página exige login, sem persistir tokens ou URLs.
  estado.sessao = { access_token: s.access_token, refresh_token: s.refresh_token, expira: Date.now() + Number(s.expires_in || 3600) * 1000 };
}
function limparSessao() {
  estado.sessao = null; estado.pedido = null; estado.bm = null;
  $("portal").hidden = true; $("acesso").hidden = false; $("sair").hidden = true;
  $("pedido").replaceChildren(); $("boletins").replaceChildren();
  $("login").hidden = false; $("definir-senha").hidden = true; $("senha").value = "";
}
async function requisicao(caminho, { method = "GET", body, binario = false, publico = false, headers = {} } = {}) {
  configurado(); if (!publico) await atualizarSessao();
  const r = await fetch(`${API}${caminho}`, {
    method, headers: { apikey: CONFIG.anonKey, ...(!publico ? { Authorization: `Bearer ${estado.sessao.access_token}` } : {}), ...(body && !(body instanceof File) ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body instanceof File ? body : body ? JSON.stringify(body) : undefined, cache: "no-store", redirect: "error"
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    if (r.status === 401 && !publico) limparSessao();
    if (e.code === "40001" || r.status === 409) throw new Error("Dados alterados. Recarregue antes de continuar; a operação não foi concluída.");
    throw new Error(publico ? "Não foi possível entrar. Confira o convite, o e-mail e a senha." : "Operação não concluída. Confira seu vínculo, o prazo, as fotos pendentes e recarregue os dados.");
  }
  return binario ? r.blob() : r.status === 204 ? null : r.json();
}
const rpc = (nome, body) => requisicao(`/rest/v1/rpc/${nome}`, { method: "POST", body });
async function linhas(tabela, consulta) {
  const todas = [];
  for (let offset = 0; ; offset += 200) {
    const lote = await requisicao(`/rest/v1/${tabela}?${consulta}&limit=200&offset=${offset}`);
    todas.push(...lote); if (lote.length < 200) return todas;
  }
}
async function tarefa(acao) {
  if (estado.ocupado) return;
  estado.ocupado = true; aviso("Aguarde…");
  document.querySelectorAll("button, select").forEach(n => n.disabled = true);
  try { await acao(); aviso("Dados atualizados."); }
  catch (e) { aviso(e instanceof Error ? e.message : "Não foi possível concluir."); }
  finally { estado.ocupado = false; document.querySelectorAll("button, select").forEach(n => n.disabled = false); }
}
function botao(pai, texto, acao) { const b = el("button", texto, pai); b.type = "button"; b.addEventListener("click", () => tarefa(acao)); return b; }
function responsavel() { return estado.vinculos.some(v => v.obra_id === estado.bm?.obra_id && v.papel === "contratada" && v.ativo && v.responsavel); }
async function abrirPortal() {
  await requisicao("/auth/v1/user");
  estado.vinculos = await linhas("vinculos", "select=obra_id,papel,responsavel,ativo&ativo=eq.true&order=id");
  estado.obras = await linhas("obras", "select=id,nome&order=nome,id");
  $("obra").replaceChildren();
  for (const o of estado.obras) { const opt = el("option", o.nome, $("obra")); opt.value = o.id; }
  $("acesso").hidden = true; $("portal").hidden = false; $("sair").hidden = false;
  if (!estado.obras.length) { aviso("Seu usuário não tem vínculo ativo com uma obra."); return; }
  await carregarBms();
}
async function carregarBms() {
  const obra = $("obra").value;
  estado.bms = await linhas("bms", `select=id,obra_id,numero,periodo_inicio,periodo_fim,prazo_reenvio,eap_versao_id,versao_linha&obra_id=eq.${encodeURIComponent(obra)}&order=numero.desc`);
  $("bm").replaceChildren();
  for (const b of estado.bms) {
    const intervalo = s => s.split("-").reverse().join("-");
    const opt = el("option", `BM ${b.numero} · ${intervalo(b.periodo_inicio)} a ${intervalo(b.periodo_fim)}`, $("bm")); opt.value = b.id;
  }
  await carregarPedido();
}
async function carregarPedido() {
  $("pedido").replaceChildren(); $("boletins").replaceChildren();
  if (!$("bm").value) { estado.bm = null; estado.pedido = null; el("p", "Nenhum BM aberto para esta obra.", $("pedido")); return; }
  const bs = await linhas("bms", `select=id,obra_id,numero,prazo_reenvio,eap_versao_id,versao_linha&id=eq.${encodeURIComponent($("bm").value)}&order=id`);
  estado.bm = bs[0]; if (!estado.bm) throw new Error("BM indisponível. Entre novamente.");
  const pedidos = await linhas("pedidos", `select=id,bm_id,revisao,status,versao_linha,enviado_em&bm_id=eq.${estado.bm.id}&order=revisao.desc`);
  estado.pedido = pedidos[0] || null;
  estado.itens = await linhas("itens", `select=id,codigo,descricao,ativo&eap_versao_id=eq.${estado.bm.eap_versao_id}&order=codigo,id`);
  el("h2", "Pedido de medição", $("pedido"));
  el("p", `Prazo de envio: ${data(estado.bm.prazo_reenvio)} (Brasília).`, $("pedido"));
  const p = estado.pedido;
  if (!p) {
    el("p", "Este BM ainda não tem pedido.", $("pedido"));
    if (responsavel()) botao($("pedido"), "Criar rascunho", async () => { await rpc("criar_pedido", { p_bm: estado.bm.id, p_versao: estado.bm.versao_linha }); await carregarPedido(); });
  } else {
    el("p", `Revisão ${p.revisao} · ${p.status}${p.enviado_em ? ` · enviada em ${data(p.enviado_em)}` : ""}`, $("pedido"));
    const pis = await linhas("pedido_itens", `select=item_id,pct_acumulado_pedido,justificativa&pedido_id=eq.${p.id}&order=item_id`);
    const anexos = await linhas("pedido_anexos", `select=id,item_id,estado,tamanho_declarado&pedido_id=eq.${p.id}&order=criado_em,id`);
    const editavel = p.status === "rascunho" && responsavel();
    const lista = editavel ? estado.itens.filter(i => i.ativo || pis.some(pi => pi.item_id === i.id)) : estado.itens.filter(i => pis.some(pi => pi.item_id === i.id));
    for (const item of lista) renderItem(item, pis.find(pi => pi.item_id === item.id), anexos.filter(a => a.item_id === item.id), editavel);
    if (editavel) botao($("pedido"), "Enviar pedido", async () => {
      await rpc("enviar_pedido", { p_pedido: p.id, p_versao: p.versao_linha }); await carregarPedido();
    });
    if (p.revisao === 1 && ["aprovado", "contestado"].includes(p.status) && responsavel()) botao($("pedido"), "Criar revisão 2", async () => {
      await rpc("criar_revisao_2", { p_pedido: p.id, p_versao: p.versao_linha, p_versao_bm: estado.bm.versao_linha }); await carregarPedido();
    });
  }
  await carregarBoletins();
}
function renderItem(item, pi, anexos, editavel) {
  const a = el("article", undefined, $("pedido")); el("h3", `${item.codigo} · ${item.descricao}`, a);
  if (editavel) {
    const lp = el("label", "Percentual acumulado pedido (%)", a); const pct = el("input", undefined, lp);
    pct.type = "number"; pct.min = "0"; pct.max = "100"; pct.step = ".01"; pct.value = pi?.pct_acumulado_pedido ?? "";
    const lj = el("label", "Justificativa", a); const justificativa = el("textarea", undefined, lj); justificativa.maxLength = 2000; justificativa.value = pi?.justificativa || "";
    botao(a, "Salvar item", async () => {
      if (!pct.value || !pct.checkValidity()) throw new Error("Informe um percentual entre 0 e 100 com até duas casas decimais.");
      await rpc("editar_item", { p_pedido: estado.pedido.id, p_versao: estado.pedido.versao_linha, p_item: item.id, p_pct: Number(pct.value), p_justificativa: justificativa.value }); await carregarPedido();
    });
    if (pi) {
      botao(a, "Remover item", async () => {
        await rpc("editar_item", { p_pedido: estado.pedido.id, p_versao: estado.pedido.versao_linha, p_item: item.id, p_pct: 0, p_justificativa: "", p_remover: true }); await carregarPedido();
      });
      const lf = el("label", "Foto JPEG ou PNG, até 10 MB", a); const arquivo = el("input", undefined, lf); arquivo.type = "file"; arquivo.accept = "image/jpeg,image/png";
      botao(a, "Enviar e processar foto", async () => {
        const f = arquivo.files[0];
        if (!f || !["image/jpeg", "image/png"].includes(f.type) || f.size === 0 || f.size > 10485760) throw new Error("Escolha uma foto JPEG ou PNG de até 10 MB.");
        const r = await rpc("reservar_anexo", { p_pedido: estado.pedido.id, p_versao: estado.pedido.versao_linha, p_item: item.id, p_tamanho: f.size });
        try {
          await requisicao(`/storage/v1/object/quarentena/${r.caminho.split("/").map(encodeURIComponent).join("/")}`, { method: "POST", body: f, headers: { "Content-Type": f.type, "x-upsert": "false" } });
          await requisicao("/functions/v1/processar_foto", { method: "POST", body: { anexo_id: r.id } });
        } finally { await carregarPedido(); }
      });
    }
  } else { el("p", `Pedido: ${pi?.pct_acumulado_pedido ?? "—"}%`, a); el("p", pi?.justificativa || "", a); }
  for (const anexo of anexos) {
    const linha = el("p", `Foto ${anexo.id} · ${anexo.estado}`, a);
    if (anexo.estado === "finalizado") botao(linha, "Baixar foto", () => baixar("baixar_foto", anexo.id, `foto-${anexo.id}.png`));
    else if (editavel) {
      botao(linha, "Tentar processar novamente", async () => { await requisicao("/functions/v1/processar_foto", { method: "POST", body: { anexo_id: anexo.id } }); await carregarPedido(); });
      botao(linha, "Remover reserva pendente", async () => { await rpc("remover_anexo", { p_pedido: estado.pedido.id, p_versao: estado.pedido.versao_linha, p_anexo: anexo.id }); await carregarPedido(); });
    }
  }
}
async function carregarBoletins() {
  const raiz = $("boletins"); el("h2", "Boletins publicados", raiz);
  const bs = await linhas("boletins", `select=id,pedido_id,versao_resultado,publicado_em,valor_periodo,faturado,retencao,liquido,excedente&bm_id=eq.${estado.bm.id}&status_publicacao=eq.publicado&order=publicado_em.desc,id`);
  if (!bs.length) el("p", "Nenhum boletim publicado.", raiz);
  for (const b of bs) {
    const a = el("article", undefined, raiz); el("h3", `Versão ${b.versao_resultado} · ${data(b.publicado_em)}`, a);
    for (const [campo, titulo] of [["valor_periodo", "Valor do período"], ["faturado", "Faturado"], ["retencao", "Retenção"], ["liquido", "Líquido"], ["excedente", "Excedente"]]) el("p", `${titulo}: ${moeda(b[campo])}`, a);
    // Percentual solicitado sempre vem da revisão efetivamente publicada.
    const pedidos = await linhas("pedido_itens", `select=item_id,pct_acumulado_pedido&pedido_id=eq.${b.pedido_id}&order=item_id`);
    const resultados = await linhas("boletim_itens", `select=item_id,pct_aprovado,situacao,motivo&boletim_id=eq.${b.id}&order=item_id`);
    const rolagem = el("div", undefined, a); rolagem.className = "rolagem";
    const tabela = el("table", undefined, rolagem); const tr = el("tr", undefined, el("thead", undefined, tabela));
    for (const titulo of ["Item", "% pedido", "% aprovado", "Situação", "Motivo"]) el("th", titulo, tr);
    const tbody = el("tbody", undefined, tabela);
    for (const bi of resultados) {
      const item = estado.itens.find(i => i.id === bi.item_id); const pi = pedidos.find(i => i.item_id === bi.item_id); const row = el("tr", undefined, tbody);
      for (const texto of [item ? `${item.codigo} · ${item.descricao}` : bi.item_id, pi?.pct_acumulado_pedido ?? "—", bi.pct_aprovado, bi.situacao, bi.motivo]) el("td", texto, row);
    }
    botao(a, "Baixar PDF", () => baixar("baixar_pdf", b.id, `boletim-${b.id}.pdf`));
  }
}
async function baixar(funcao, id, nome) {
  const blob = await requisicao(`/functions/v1/${funcao}`, { method: "POST", body: { id }, binario: true });
  const url = URL.createObjectURL(blob); const a = el("a"); a.href = url; a.download = nome; document.body.append(a); a.click(); a.remove();
  // URL local em memória, revogada após iniciar o download; nunca guardar em banco ou storage web.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("login").addEventListener("submit", e => { e.preventDefault(); tarefa(async () => {
  const s = await requisicao("/auth/v1/token?grant_type=password", { method: "POST", publico: true, body: { email: $("email").value.trim(), password: $("senha").value } });
  $("senha").value = ""; guardarSessao(s); await abrirPortal();
}); });
$("definir-senha").addEventListener("submit", e => { e.preventDefault(); tarefa(async () => {
  await requisicao("/auth/v1/user", { method: "PUT", body: { password: $("nova-senha").value } }); $("nova-senha").value = ""; $("definir-senha").hidden = true; await abrirPortal();
}); });
$("sair").addEventListener("click", () => tarefa(async () => { try { await requisicao("/auth/v1/logout", { method: "POST" }); } finally { limparSessao(); } }));
$("obra").addEventListener("change", () => tarefa(carregarBms)); $("bm").addEventListener("change", () => tarefa(carregarPedido));
$("recarregar").addEventListener("click", () => tarefa(carregarPedido));
async function convite() {
  const hash = new URLSearchParams(location.hash.slice(1)); const query = new URLSearchParams(location.search);
  // Limpa o endereço antes de qualquer chamada e sem carregar recursos externos.
  history.replaceState(null, "", location.pathname);
  if (hash.has("error") || query.has("error")) throw new Error("Convite inválido ou expirado. Peça um novo convite à administração.");
  if (hash.get("type") === "invite" && hash.has("access_token")) {
    configurado(); guardarSessao({ access_token: hash.get("access_token"), refresh_token: hash.get("refresh_token"), expires_in: hash.get("expires_in") });
  } else if (query.get("type") === "invite" && query.has("token_hash")) {
    guardarSessao(await requisicao("/auth/v1/verify", { method: "POST", publico: true, body: { token_hash: query.get("token_hash"), type: "invite" } }));
  } else { configurado(); return; }
  await requisicao("/auth/v1/user"); $("login").hidden = true; $("definir-senha").hidden = false; $("sair").hidden = false;
  aviso("Convite validado. Defina sua senha.");
}
convite().catch(e => aviso(e.message));
