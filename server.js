const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

/** =========================
 *  CONFIG GITHUB
 *  ========================= */
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const GH_OWNER = process.env.GITHUB_OWNER || "brunoguim";
const GH_REPO = process.env.GITHUB_REPO || "ml-oauth";
const GH_BRANCH = process.env.GITHUB_BRANCH || "main";

const GH_QR_PATH = process.env.GITHUB_QR_PATH || "quick_replies.json";
const GH_STORES_PATH = process.env.GITHUB_STORES_PATH || "stores_ml.json";

function b64encode(str) {
  return Buffer.from(str, "utf8").toString("base64");
}
function b64decode(b64) {
  return Buffer.from(b64, "base64").toString("utf8");
}

async function ghGetJson(filePath) {
  // Nunca derruba o servidor
  if (!GH_TOKEN) return { data: [], sha: null };

  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(
    filePath
  )}`;

  try {
    const resp = await axios.get(url, {
      headers: {
        Authorization: `token ${GH_TOKEN}`,
        "User-Agent": "ml-oauth-render",
        Accept: "application/vnd.github+json"
      },
      params: { ref: GH_BRANCH }
    });

    const sha = resp.data?.sha || null;
    const contentB64 = resp.data?.content || "";

    let data = [];
    try {
      data = JSON.parse(b64decode(contentB64));
    } catch (e) {
      data = [];
    }

    return { data, sha };
  } catch (e) {
    console.log(
      "[GitHub] ghGetJson falhou:",
      filePath,
      e.response?.status,
      e.response?.data || e.message
    );
    return { data: [], sha: null };
  }
}

async function ghPutJson(filePath, data, message, sha) {
  // Nunca derruba o servidor
  if (!GH_TOKEN) return { sha: sha || null, ok: false };

  const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(
    filePath
  )}`;

  const body = {
    message,
    content: b64encode(JSON.stringify(data, null, 2)),
    branch: GH_BRANCH
  };
  if (sha) body.sha = sha;

  try {
    const resp = await axios.put(url, body, {
      headers: {
        Authorization: `token ${GH_TOKEN}`,
        "User-Agent": "ml-oauth-render",
        Accept: "application/vnd.github+json"
      }
    });

    const newSha = resp.data?.content?.sha || sha || null;
    return { sha: newSha, ok: true };
  } catch (e) {
    console.log(
      "[GitHub] ghPutJson falhou:",
      filePath,
      e.response?.status,
      e.response?.data || e.message
    );
    return { sha: sha || null, ok: false };
  }
}

/** =========================
 *  QUICK REPLIES (até 50) - GitHub
 *  ========================= */
const QUICK_REPLIES_LIMIT = 50;
const QUICK_REPLY_TEXT_MAX = 4000;

function normalizeQuickReplies(list) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];

  for (let i = 0; i < arr.length && out.length < QUICK_REPLIES_LIMIT; i++) {
    const r = arr[i] || {};
    const id = Number(r.id) || 0;
    const text = String(r.text || "").slice(0, QUICK_REPLY_TEXT_MAX);
    if (!text && !id) continue;
    out.push({ id: id || 0, text });
  }

  // dedup por id
  const seen = new Set();
  const dedup = [];
  for (const r of out) {
    const key = Number(r.id) || 0;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    dedup.push(r);
  }

  // ids garantidos
  let maxId = 0;
  for (const r of dedup) maxId = Math.max(maxId, Number(r.id) || 0);

  const seen2 = new Set();
  for (const r of dedup) {
    if (!r.id || r.id <= 0 || seen2.has(r.id)) {
      maxId += 1;
      r.id = maxId;
    }
    seen2.add(r.id);
    r.text = String(r.text || "").slice(0, QUICK_REPLY_TEXT_MAX);
  }

  return dedup.slice(0, QUICK_REPLIES_LIMIT);
}

let QR_CACHE = [];
let QR_SHA = null;
let QR_AT = 0;

async function loadQuickReplies(force = false) {
  const now = Date.now();
  if (!force && now - QR_AT < 5000) return { replies: QR_CACHE, sha: QR_SHA };

  const { data, sha } = await ghGetJson(GH_QR_PATH);
  const normalized = normalizeQuickReplies(data);

  QR_CACHE = normalized;
  QR_SHA = sha;
  QR_AT = now;

  return { replies: normalized, sha };
}

async function saveQuickReplies(list, message) {
  const normalized = normalizeQuickReplies(list);
  const current = await loadQuickReplies(true);

  const put = await ghPutJson(GH_QR_PATH, normalized, message, current.sha);

  QR_CACHE = normalized;
  QR_SHA = put.sha;
  QR_AT = Date.now();

  return normalized;
}

/** =========================
 *  STORES ML (lojas) - GitHub
 *  ========================= */
let STORES = [];
let STORES_SHA = null;
let STORES_AT = 0;

function normalizeStores(list) {
  const arr = Array.isArray(list) ? list : [];
  return arr
    .map(s => ({
      user_id: s?.user_id,
      store_name: s?.store_name || "",
      refresh_token: s?.refresh_token || "",
      access_token: s?.access_token || ""
    }))
    .filter(s => s.user_id && s.refresh_token);
}

async function loadStores(force = false) {
  const now = Date.now();

  if (!force && now - STORES_AT < 5000 && Array.isArray(STORES) && STORES.length) {
    return STORES;
  }

  const { data, sha } = await ghGetJson(GH_STORES_PATH);
  STORES = normalizeStores(data);
  STORES_SHA = sha;
  STORES_AT = now;

  return STORES;
}

async function saveStores(message) {
  const safe = normalizeStores(STORES);
  const put = await ghPutJson(GH_STORES_PATH, safe, message, STORES_SHA);
  STORES_SHA = put.sha;
  STORES_AT = Date.now();
  return safe;
}

/** =========================
 *  REFRESH TOKEN (Mercado Livre)
 *  ========================= */
async function refreshAccessToken(store) {
  const resp = await axios.post("https://api.mercadolibre.com/oauth/token", {
    grant_type: "refresh_token",
    client_id: process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET,
    refresh_token: store.refresh_token
  });

  store.access_token = resp.data.access_token;

  // se vier refresh novo, persiste no GitHub
  if (resp.data.refresh_token && resp.data.refresh_token !== store.refresh_token) {
    store.refresh_token = resp.data.refresh_token;
    await saveStores("Update ML refresh_token");
  }
}

/** =========================
 *  HELPERS
 *  ========================= */
function cutoffTimestamp(days) {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

function forceHttps(url) {
  if (!url) return "";
  return url.startsWith("http://") ? url.replace("http://", "https://") : url;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Busca itens em lote: /items?ids=ID1,ID2...
 * Retorna title, thumbnail e permalink
 */
async function fetchItemsBulk(store, itemIds) {
  const resultMap = new Map();
  if (!itemIds || itemIds.length === 0) return resultMap;

  const unique = Array.from(new Set(itemIds));
  const batches = chunk(unique, 20);

  const doCall = async (idsBatch) => {
    const url = `https://api.mercadolibre.com/items?ids=${idsBatch.join(",")}`;
    return axios.get(url, { headers: { Authorization: `Bearer ${store.access_token}` } });
  };

  for (const idsBatch of batches) {
    let resp;
    try {
      resp = await doCall(idsBatch);
    } catch (err) {
      if (err.response?.status === 401) {
        await refreshAccessToken(store);
        resp = await doCall(idsBatch);
      } else {
        continue;
      }
    }

    const arr = resp.data || [];
    for (const entry of arr) {
      const code = entry?.code;
      const body = entry?.body;
      const id = body?.id || entry?.id;

      if (code === 200 && body && id) {
        const title = body.title || "";
        const thumbnail = forceHttps(
          body.secure_thumbnail ||
            body.thumbnail ||
            body.pictures?.[0]?.secure_url ||
            body.pictures?.[0]?.url ||
            ""
        );
        const permalink = body.permalink || "";
        resultMap.set(id, { title, thumbnail, permalink });
      }
    }
  }

  return resultMap;
}

async function fetchQuestionsForStore(store) {
  const MAX_DAYS = 90;
  const cutoff = cutoffTimestamp(MAX_DAYS);

  const doQuestionsCall = () =>
    axios.get(
      `https://api.mercadolibre.com/questions/search?seller_id=${store.user_id}&status=UNANSWERED`,
      { headers: { Authorization: `Bearer ${store.access_token}` } }
    );

  let qResp;
  try {
    qResp = await doQuestionsCall();
  } catch (err) {
    if (err.response?.status === 401) {
      await refreshAccessToken(store);
      qResp = await doQuestionsCall();
    } else {
      throw err;
    }
  }

  const questionsRaw = (qResp.data.questions || []).filter(q => {
    const dt = new Date(q.date_created).getTime();
    return !isNaN(dt) && dt >= cutoff;
  });

  const itemIds = questionsRaw.map(q => q.item_id).filter(Boolean);
  const itemsMap = await fetchItemsBulk(store, itemIds);

  return questionsRaw.map(q => {
    const item = itemsMap.get(q.item_id) || null;
    return {
      ...q,
      store_id: store.user_id,
      store_name: store.store_name,
      item_title: item?.title || "",
      item_thumbnail: item?.thumbnail || "",
      item_permalink: item?.permalink || "" // ✅ link do anúncio
    };
  });
}

/** =========================
 *  HISTÓRICO POR ANÚNCIO
 *  ========================= */
async function fetchHistoryForItem(store, itemId, limit = 10) {
  const lim = Math.max(1, Math.min(Number(limit) || 10, 30));

  const doCall = () =>
    axios.get(
      `https://api.mercadolibre.com/questions/search?item_id=${encodeURIComponent(
        itemId
      )}&seller_id=${encodeURIComponent(store.user_id)}&limit=${lim}`,
      { headers: { Authorization: `Bearer ${store.access_token}` } }
    );

  let resp;
  try {
    resp = await doCall();
  } catch (err) {
    if (err.response?.status === 401) {
      await refreshAccessToken(store);
      resp = await doCall();
    } else {
      throw err;
    }
  }

  const questions = resp.data?.questions || [];
  return questions.map(q => ({
    id: q.id,
    date_created: q.date_created,
    text: q.text || "",
    answer_text: q.answer?.text || "",
    answer_date: q.answer?.date_created || "",
    from_id: q.from?.id || null,
    from_nickname: q.from?.nickname || ""
  }));
}

/** =========================
 *  ROTAS
 *  ========================= */
app.get("/", (req, res) => {
  res.send(`
    <h2>Autenticar Loja</h2>
    <a href="https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${process.env.CLIENT_ID}&redirect_uri=${process.env.REDIRECT_URI}">
      Conectar Mercado Livre
    </a>
    <br><br>
    <a href="/panel.html">Ir para o painel</a>
  `);
});

app.get("/auth/callback", async (req, res) => {
  const code = req.query.code;

  try {
    const response = await axios.post("https://api.mercadolibre.com/oauth/token", {
      grant_type: "authorization_code",
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      code,
      redirect_uri: process.env.REDIRECT_URI
    });

    const access_token = response.data.access_token;
    const refresh_token = response.data.refresh_token;

    const user = await axios.get("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const user_id = user.data.id;
    const store_name = user.data.nickname || ("Loja " + user_id);

    await loadStores(true);

    const existing = STORES.find(s => String(s.user_id) === String(user_id));
    if (existing) {
      existing.access_token = access_token;
      existing.refresh_token = refresh_token;
      existing.store_name = store_name;
    } else {
      STORES.push({ user_id, store_name, access_token, refresh_token });
    }

    await saveStores("Connect/Update ML store");

    res.send(`
      <h3>Loja conectada com sucesso!</h3>
      <p>Total de lojas conectadas: ${STORES.length}</p>
      <a href="/">Conectar outra loja</a>
      <br><br>
      <a href="/panel.html">Ir para o painel</a>
    `);
  } catch (error) {
    console.log("Erro ao autenticar ML:", error.response?.data || error.message);
    res.send("Erro ao autenticar.");
  }
});

/** NÃO quebra o painel: sempre retorna JSON (lista ou []) */
app.get("/questions", async (req, res) => {
  try {
    await loadStores(false);

    if (!Array.isArray(STORES) || STORES.length === 0) {
      return res.json([]);
    }

    let allQuestions = [];
    for (const store of STORES) {
      try {
        const qs = await fetchQuestionsForStore(store);
        allQuestions = allQuestions.concat(qs);
      } catch (error) {
        console.log(
          "Erro ao buscar perguntas/enriquecer:",
          error.response?.data || error.message
        );
      }
    }

    return res.json(allQuestions);
  } catch (e) {
    console.log("Falha geral /questions:", e.response?.data || e.message);
    return res.json([]);
  }
});

/** Histórico do anúncio (perguntas e respostas) */
app.get("/question-history", async (req, res) => {
  try {
    const store_id = req.query.store_id;
    const item_id = req.query.item_id;
    const limit = req.query.limit || 10;

    if (!store_id || !item_id) {
      return res.status(400).json({ success: false, error: "store_id e item_id são obrigatórios" });
    }

    await loadStores(false);

    const store = (STORES || []).find(s => String(s.user_id) === String(store_id));
    if (!store) {
      return res.status(400).json({ success: false, error: "Loja não encontrada" });
    }

    const history = await fetchHistoryForItem(store, item_id, limit);
    return res.json({ success: true, history });
  } catch (e) {
    console.log("Erro /question-history:", e.response?.data || e.message);
    return res.status(500).json({ success: false, error: "Falha ao buscar histórico" });
  }
});

app.post("/reply", async (req, res) => {
  const { question_id, text, store_id } = req.body;

  try {
    await loadStores(false);

    const store = STORES.find(s => String(s.user_id) === String(store_id));
    if (!store) return res.status(400).json({ success: false, error: "Loja não encontrada" });

    const sendAnswer = () =>
      axios.post(
        "https://api.mercadolibre.com/answers",
        { question_id, text },
        { headers: { Authorization: `Bearer ${store.access_token}` } }
      );

    try {
      await sendAnswer();
      return res.json({ success: true });
    } catch (error) {
      if (error.response?.status === 401) {
        try {
          await refreshAccessToken(store);
          await sendAnswer();
          return res.json({ success: true, refreshed: true });
        } catch (e2) {
          return res.status(400).json({
            success: false,
            error: "Falha ao responder após renovar token",
            details: e2.response?.data || e2.message
          });
        }
      }

      return res.status(400).json({
        success: false,
        error: "Falha ao responder",
        details: error.response?.data || error.message
      });
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: "Erro interno ao responder" });
  }
});

/** =========================
 *  QUICK REPLIES API (GitHub)
 *  ========================= */
app.get("/quick-replies", async (req, res) => {
  try {
    const { replies } = await loadQuickReplies(false);
    res.json({ success: true, replies });
  } catch (e) {
    res.json({ success: true, replies: [] });
  }
});

app.post("/quick-replies", async (req, res) => {
  const text = (req.body?.text || "").toString().trim();
  if (!text) return res.status(400).json({ success: false, error: "Texto vazio" });

  try {
    const cur = await loadQuickReplies(true);
    const list = Array.isArray(cur.replies) ? cur.replies : [];

    if (list.length >= QUICK_REPLIES_LIMIT) {
      return res.status(400).json({ success: false, error: "Limite de 50 respostas atingido" });
    }

    const maxId = list.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
    const nextId = maxId + 1;

    list.push({ id: nextId, text: text.slice(0, QUICK_REPLY_TEXT_MAX) });
    const saved = await saveQuickReplies(list, "Add quick reply");

    res.json({ success: true, replies: saved });
  } catch (e) {
    res.status(500).json({ success: false, error: "Falha ao adicionar resposta rápida" });
  }
});

app.put("/quick-replies/:id", async (req, res) => {
  const id = Number(req.params.id);
  const text = (req.body?.text || "").toString().trim();
  if (!text) return res.status(400).json({ success: false, error: "Texto vazio" });

  try {
    const cur = await loadQuickReplies(true);
    const list = Array.isArray(cur.replies) ? cur.replies : [];

    const idx = list.findIndex(r => Number(r.id) === id);
    if (idx === -1) return res.status(404).json({ success: false, error: "Não encontrado" });

    list[idx].text = text.slice(0, QUICK_REPLY_TEXT_MAX);
    const saved = await saveQuickReplies(list, "Edit quick reply");

    res.json({ success: true, replies: saved });
  } catch (e) {
    res.status(500).json({ success: false, error: "Falha ao editar resposta rápida" });
  }
});

app.delete("/quick-replies/:id", async (req, res) => {
  const id = Number(req.params.id);

  try {
    const cur = await loadQuickReplies(true);
    let list = Array.isArray(cur.replies) ? cur.replies : [];

    const before = list.length;
    list = list.filter(r => Number(r.id) !== id);

    if (list.length === before) {
      return res.status(404).json({ success: false, error: "Não encontrado" });
    }

    const saved = await saveQuickReplies(list, "Delete quick reply");
    res.json({ success: true, replies: saved });
  } catch (e) {
    res.status(500).json({ success: false, error: "Falha ao excluir resposta rápida" });
  }
});

app.listen(3000, () => console.log("Servidor rodando na porta 3000"));
