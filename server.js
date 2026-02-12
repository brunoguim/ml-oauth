const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static("public"));

let STORE = {
  user_id: null,
  access_token: null,
  refresh_token: null
};

app.get("/", (req, res) => {
  res.send(`
    <h2>Autenticar Loja</h2>
    <a href="https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${process.env.CLIENT_ID}&redirect_uri=${process.env.REDIRECT_URI}">
      Conectar Mercado Livre
    </a>
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

    STORE.access_token = response.data.access_token;
    STORE.refresh_token = response.data.refresh_token;

    const user = await axios.get("https://api.mercadolibre.com/users/me", {
      headers: {
        Authorization: `Bearer ${STORE.access_token}`
      }
    });

    STORE.user_id = user.data.id;

    res.send(`
      <h3>Loja conectada com sucesso!</h3>
      <a href="/panel.html">Ir para o painel</a>
    `);

  } catch (error) {
    console.log(error.response?.data || error.message);
    res.send("Erro ao autenticar.");
  }
});

app.get("/questions", async (req, res) => {
  try {
    const response = await axios.get(
      `https://api.mercadolibre.com/questions/search?seller_id=${STORE.user_id}&status=UNANSWERED`,
      {
        headers: {
          Authorization: `Bearer ${STORE.access_token}`
        }
      }
    );

    res.json(response.data.questions);

  } catch (error) {
    console.log(error.response?.data || error.message);
    res.json({ error: "Erro ao buscar perguntas" });
  }
});

app.post("/reply", async (req, res) => {
  const { question_id, text } = req.body;

  try {
    await axios.post(
      "https://api.mercadolibre.com/answers",
      {
        question_id,
        text
      },
      {
        headers: {
          Authorization: `Bearer ${STORE.access_token}`
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
