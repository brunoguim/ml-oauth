const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

let STORES = [];

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

    STORES.push({ user_id, store_name, access_token, refresh_token });

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
        {
          headers: {
            Authorization: `Bearer ${store.access_token}`
          }
        }
      );

      const questions = response.data.questions.map(q => ({
        ...q,
        store_id: store.user_id,
        store_name: store.store_name
      }));

      allQuestions = allQuestions.concat(questions);

    } catch (error) {
      console.log("Erro ao buscar perguntas:", error.message);
    }
  }

  res.json(allQuestions);
});

app.post("/reply", async (req, res) => {
  const { question_id, text, store_id } = req.body;

  const store = STORES.find(s => s.user_id == store_id);

  if (!store) {
    return res.json({ error: "Loja não encontrada" });
  }

  try {
    await axios.post(
      "https://api.mercadolibre.com/answers",
      { question_id, text },
      {
        headers: {
          Authorization: `Bearer ${store.access_token}`
        }
      }
    );

    res.json({ success: true });

  } catch (error) {
    console.log(error.response?.data || error.message);
    res.json({ error: "Erro ao responder" });
  }
});

app.listen(3000, () => console.log("Servidor rodando na porta 3000"));
