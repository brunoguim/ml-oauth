const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send('Servidor OAuth Mercado Livre funcionando.');
});

app.get('/auth/callback', (req, res) => {
  res.send('Autorização recebida com sucesso! Você pode fechar esta aba.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Servidor rodando na porta ' + PORT);
});
