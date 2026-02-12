const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

let STORES = [];

/** =========================
 *  CACHE DE ITENS
 *  ========================= */
const ITEM_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas
const itemCache = new Map(); // item_id -> { data, expiresAt }

function forceHttps(url) {
  if (!url) return "";
  return url.startsWith("http://") ? url.replace("http://", "https://") : url;
}

async function getItemInfo(itemId) {
  if (!itemId) return null;

  const cached = itemCache.get(itemId);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  // Busca pública do item
  const resp = await axios.get(`https://api.mercadolibre.com/items/${itemId}`);

  const title = resp.data?.title || "";

  const thumbnail = forceHttps(
    resp.data?.secure_thumbnail ||
    resp.data?.thumbnail ||
    resp.data?.pictures?.[0]?.secure_url ||
    resp.data?.pictures?.[0]?.url ||
    ""
  );

  const data = { item_id: itemId, title, thumbnail };

  itemCache.set(itemId, { data, expiresAt: Date.now() + ITEM_CACHE_TTL_MS });
  return data;
}

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

async function fetchQuestionsForStore(store) {
  const MAX_DAYS = 90;
  const cutoff = cutoffTimestamp(MAX_DAYS);

  const resp = await axios.get(
    `https://api.mercadolibre.com/questions/search?seller_id=${store.user_id}&status=UNANSWERED`,
    { headers: { Authorization: `Bearer ${store.access_token}` } }
  );

  const enriched = [];

  for (const q of (resp.data.questions || [])) {
    const dt = new Date(q.date_created).getTime();
    if (isNaN(dt) || dt < cutoff) continue;

    let item_title = "";
    let item_thumbnail = "";
    let item_error = "";

    if (q.item_id) {
      try {
        const item = await getItemInfo(q.item_id);
        item_title = item?.title || "";
        item_thumbnail = item?.thumbnail || "";
      } catch (e) {
        // devolve erro pra debug
        item_error = e.response?.data
          ? JSON.stringify(e.response.data)
          : (e.message || "erro ao buscar item");
      }
    } else {
      item_error = "pergunta sem item_id";
    }

    enriched.push({
      ...q,
      store_id: store.user_id,
      store_name: store.store_name,
      item_title,
      item_thumbnail,
      item_error // debug
    });
  }

  return enriched;
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
      if (error.response?.status === 401) {
        try {
          await refreshAccessToken(store);
          const qs = await fetchQuestionsForStore(store);
          allQuestions = allQuestions.concat(qs);
        } catch (e2) {
          console.log("Erro ao renovar token (questions):", e2.response?.data || e2.message);
        }
      } else {
        console.log("Erro ao buscar perguntas:", error.response?.data || error.message);
      }
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
          error: "Falha ao responder (mesmo após renovar token)",
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

app.listen(3000, () => console.log("Servidor rodando na porta 3000"));
