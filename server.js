const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

let STORES = [];

// Cache simples de itens (para não chamar API toda hora)
const ITEM_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas
const itemCache = new Map(); // item_id -> { data, expiresAt }

async function getItemInfo(store, itemId) {
  if (!itemId) return null;

  const cached = itemCache.get(itemId);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  // Busca o item (título, thumbnail etc.)
  const resp = await axios.get(`https://api.mercadolibre.com/items/${itemId}`, {
    headers: { Authorization: `Bearer ${store.access_token}` }
  });

  const data = {
    item_id: itemId,
    title: resp.data.title || "",
    thumbnail: resp.data.thumbnail || "" // geralmente vem aqui
  };

  itemCache.set(itemId, { data, expiresAt: Date.now() + ITEM_CACHE_TTL_MS });
  return data;
}


/**
 * Tenta renovar o access_token usando refresh_token
 */
async function refreshAccessToken(store) {
  const resp = await axios.post("https://api.mercadolibre.com/oauth/token", {
    grant_type: "refresh_token",
    client_id: process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET,
    refresh_token: store.refresh_token
  });

  store.access_token = resp.data.access_token;

  // Em alguns casos o ML pode devolver um refresh_token novo
  if (resp.data.refresh_token) {
    store.refresh_token = resp.data.refresh_token;
  }
}

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

    // Evita duplicar a mesma loja se você autorizar de novo
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
      const response = await axios.get(
        `https://api.mercadolibre.com/questions/search?seller_id=${store.user_id}&status=UNANSWERED`,
        { headers: { Authorization: `Bearer ${store.access_token}` } }
      );

      const MAX_DAYS = 90;
      const cutoff = Date.now() - MAX_DAYS * 24 * 60 * 60 * 1000;

      const questions = response.data.questions
        .filter(q => {
          const dt = new Date(q.date_created).getTime();
          return !isNaN(dt) && dt >= cutoff;
        })
        .map(q => ({
          ...q,
          store_id: store.user_id,
          store_name: store.store_name
        }));

      allQuestions = allQuestions.concat(questions);

    } catch (error) {
      // Se token expirou, tenta renovar e tentar 1x
      if (error.response?.status === 401) {
        try {
          await refreshAccessToken(store);

          const retry = await axios.get(
            `https://api.mercadolibre.com/questions/search?seller_id=${store.user_id}&status=UNANSWERED`,
            { headers: { Authorization: `Bearer ${store.access_token}` } }
          );

          const MAX_DAYS = 90;
          const cutoff = Date.now() - MAX_DAYS * 24 * 60 * 60 * 1000;

          const questions = retry.data.questions
            .filter(q => {
              const dt = new Date(q.date_created).getTime();
              return !isNaN(dt) && dt >= cutoff;
            })
            .map(q => ({
              ...q,
              store_id: store.user_id,
              store_name: store.store_name
            }));

          allQuestions = allQuestions.concat(questions);
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
  if (!store) {
    return res.status(400).json({ success: false, error: "Loja não encontrada" });
  }

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
    // Se token expirou, tenta renovar e reenviar 1x
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
