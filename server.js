const express = require("express");
const axios = require("axios");
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static("public"));

let STORES = [];

/** =========================
 *  QUICK REPLIES (até 50) - Persistente em arquivo
 *  Arquivo: quick_replies.json
 *  ========================= */
const QUICK_REPLIES_FILE = path.join(__dirname, "quick_replies.json");
const QUICK_REPLIES_LIMIT = 50;
const QUICK_REPLY_TEXT_MAX = 4000;

function normalizeQuickReplies(list) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];

  for (let i = 0; i < arr.length && out.length < QUICK_REPLIES_LIMIT; i++) {
    const r = arr[i] || {};
    const id = Number(r.id) || 0;
    const text = String(r.text || "").slice(0, QUICK_REPLY_TEXT_MAX);

    // ignora entradas totalmente inválidas
    if (!text && !id) continue;

    out.push({ id: id || 0, text });
  }

  // remove ids duplicados mantendo o primeiro
  const seen = new Set();
  const dedup = [];
  for (const r of out) {
    const key = Number(r.id) || 0;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    dedup.push(r);
  }

  // se alguma entry veio com id=0, vamos reatribuir depois ao salvar.
  return dedup.slice(0, QUICK_REPLIES_LIMIT);
}

function loadQuickRepliesFromFile() {
  try {
    if (!fs.existsSync(QUICK_REPLIES_FILE)) {
      fs.writeFileSync(QUICK_REPLIES_FILE, JSON.stringify([], null, 2), "utf-8");
      return [];
    }
    const raw = fs.readFileSync(QUICK_REPLIES_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return normalizeQuickReplies(parsed);
  } catch (e) {
    return [];
  }
}

function saveQuickRepliesToFile(list) {
  const normalized = normalizeQuickReplies(list);

  // garante ids válidos (se houver id 0) e não duplicados
  let maxId = 0;
  for (const r of normalized) maxId = Math.max(maxId, Number(r.id) || 0);

  const seen = new Set();
  for (const r of normalized) {
    if (!r.id || r.id <= 0 || seen.has(r.id)) {
      maxId += 1;
      r.id = maxId;
    }
    seen.add(r.id);
    r.text = String(r.text || "").slice(0, QUICK_REPLY_TEXT_MAX);
  }

  const safe = normalized.slice(0, QUICK_REPLIES_LIMIT);
  fs.writeFileSync(QUICK_REPLIES_FILE, JSON.stringify(safe, null, 2), "utf-8");
  return safe;
}

// estado em memória (carregado do arquivo ao iniciar)
let QUICK_REPLIES = loadQuickRepliesFromFile();

/** =========================
 *  REFRESH TOKEN
 *  ========================= */
async function refreshAccessToken(store) {
  const resp = await axios.post("https://api.mercadolibre.com/oauth/token", {
    grant_type: "refresh_token",
    client_id: process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET,
    refresh_token: store.refresh_token
  });

  store.access_token = resp.data.access_token;
  if (resp.data.refresh_token) store.refresh_token = resp.data.refresh_token;
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
 */
async function fetchItemsBulk(store, itemIds) {
  const resultMap = new Map();
  if (!itemIds || itemIds.length === 0) return resultMap;

  const unique = Array.from(new Set(itemIds));
  const batches = chunk(unique, 20);

  const doCall = async (idsBatch) => {
    const url = `https://api.mercadolibre.com/items?ids=${idsBatch.join(",")}`;
    return axios.get(url, {
      headers: { Authorization: `Bearer ${store.access_token}` }
    });
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

        resultMap.set(id, { title, thumbnail });
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
      item_thumbnail: item?.thumbnail || ""
    };
  });
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
      code: code,
      redirect_uri: process.env.REDIRECT_URI
    });

    const access_token = response.data.access_token;
    const refresh_token = response.data.refresh_token;

    const user = await axios.get("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const user_id = user.data.id;
    const store_name = user.data.nickname || ("Loja " + user_id);

    const existing = STORES.find(s => String(s.user_id) === String(user_id));
    if (existing) {
      existing.access_token = access_token;
      existing.refresh_token = refresh_token;
      existing.store_name = store_name;
    } else {
      STORES.push({ user_id, store_name, access_token, refresh_token });
    }

    res.send(`
      <h3>Loja conectada com sucesso!</h3>
      <p>Total de lojas conectadas: ${STORES.length}</p>
      <a href="/">Conectar outra loja</a>
      <br><br>
      <a href="/panel.html">Ir para o painel</a>
    `);
  } catch (error) {
    console.log(error.response?.data || error.message);
    res.send("Erro ao autenticar.");
  }
});

app.get("/questions", async (req, res) => {
  let allQuestions = [];

  for (const store of STORES) {
    try {
      const qs = await fetchQuestionsForStore(store);
      allQuestions = allQuestions.concat(qs);
    } catch (error) {
      console.log("Erro ao buscar perguntas/enriquecer:", error.response?.data || error.message);
    }
  }

  res.json(allQuestions);
});

app.post("/reply", async (req, res) => {
  const { question_id, text, store_id } = req.body;

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
});

/** =========================
 *  QUICK REPLIES API (compartilhado entre lojas)
 *  Persistente em quick_replies.json
 *  ========================= */
app.get("/quick-replies", (req, res) => {
  // garante que o painel sempre pegue o mais recente (até se outro processo editar o arquivo)
  QUICK_REPLIES = loadQuickRepliesFromFile();
  res.json({ success: true, replies: QUICK_REPLIES });
});

// adicionar (adiciona no final, id incremental)
app.post("/quick-replies", (req, res) => {
  const text = (req.body?.text || "").toString().trim();
  if (!text) return res.status(400).json({ success: false, error: "Texto vazio" });

  QUICK_REPLIES = loadQuickRepliesFromFile();

  if (QUICK_REPLIES.length >= QUICK_REPLIES_LIMIT) {
    return res.status(400).json({ success: false, error: "Limite de 50 respostas atingido" });
  }

  const maxId = QUICK_REPLIES.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
  const nextId = maxId + 1;

  QUICK_REPLIES.push({ id: nextId, text: text.slice(0, QUICK_REPLY_TEXT_MAX) });
  QUICK_REPLIES = saveQuickRepliesToFile(QUICK_REPLIES);

  res.json({ success: true, replies: QUICK_REPLIES });
});

// editar
app.put("/quick-replies/:id", (req, res) => {
  const id = Number(req.params.id);
  const text = (req.body?.text || "").toString().trim();
  if (!text) return res.status(400).json({ success: false, error: "Texto vazio" });

  QUICK_REPLIES = loadQuickRepliesFromFile();

  const idx = QUICK_REPLIES.findIndex(r => Number(r.id) === id);
  if (idx === -1) return res.status(404).json({ success: false, error: "Não encontrado" });

  QUICK_REPLIES[idx].text = text.slice(0, QUICK_REPLY_TEXT_MAX);
  QUICK_REPLIES = saveQuickRepliesToFile(QUICK_REPLIES);

  res.json({ success: true, replies: QUICK_REPLIES });
});

// deletar
app.delete("/quick-replies/:id", (req, res) => {
  const id = Number(req.params.id);
  QUICK_REPLIES = loadQuickRepliesFromFile();

  const before = QUICK_REPLIES.length;
  QUICK_REPLIES = QUICK_REPLIES.filter(r => Number(r.id) !== id);

  if (QUICK_REPLIES.length === before) {
    return res.status(404).json({ success: false, error: "Não encontrado" });
  }

  QUICK_REPLIES = saveQuickRepliesToFile(QUICK_REPLIES);
  res.json({ success: true, replies: QUICK_REPLIES });
});

app.listen(3000, () => console.log("Servidor rodando na porta 3000"));
