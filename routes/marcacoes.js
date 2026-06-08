const express = require("express");
const axios = require("axios");

const router = express.Router();

let secullumToken = null;

const cacheMarcacoes = {};

async function gerarTokenSecullum() {
  const params = new URLSearchParams();

  params.append("grant_type", "password");
  params.append("username", process.env.SECULLUM_USERNAME);
  params.append("password", process.env.SECULLUM_PASSWORD);
  params.append("client_id", process.env.SECULLUM_CLIENT_ID || "3");

  const response = await axios.post(
    "https://autenticador.secullum.com.br/token",
    params,
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    }
  );

  secullumToken = response.data.access_token;

  console.log("Token Secullum gerado nas marcações");

  return secullumToken;
}

async function obterTokenSecullum() {
  if (!secullumToken) {
    return await gerarTokenSecullum();
  }

  return secullumToken;
}

router.get("/", async (req, res) => {
  try {
    const { numeroFolha, dataInicio, dataFim } = req.query;

    if (!numeroFolha || !dataInicio || !dataFim) {
      return res.status(400).json({
        erro: "Parâmetros obrigatórios: numeroFolha, dataInicio, dataFim"
      });
    }

    const chaveCache = `${numeroFolha}-${dataInicio}-${dataFim}`;

    if (cacheMarcacoes[chaveCache]) {
      console.log("Marcações retornadas do cache");
      return res.json(cacheMarcacoes[chaveCache]);
    }

    const response = await axios.get(process.env.SECULLUM_MARCACOES_URL, {
      params: {
        DataInicio: dataInicio,
        DataFim: dataFim
      },
      headers: {
        Authorization: `Bearer ${await obterTokenSecullum()}`,
        secullumidbancoselecionado: process.env.SECULLUM_BANCO_ID
      }
    });

    const marcacoesFiltradas = response.data.filter(item =>
      String(item.Funcionario?.NumeroFolha) === String(numeroFolha)
    );

    const resultado = marcacoesFiltradas.map(item => ({
      numeroFolha: item.Funcionario?.NumeroFolha || numeroFolha,
      data: item.Data?.split("T")[0],

      entrada1: item.Entrada1 || "",
      saida1: item.Saida1 || "",

      entrada2: item.Entrada2 || "",
      saida2: item.Saida2 || "",

      entrada3: item.Entrada3 || "",
      saida3: item.Saida3 || "",

      observacoes: item.Observacoes || ""
    }));

    cacheMarcacoes[chaveCache] = resultado;

    console.log(`Marcações salvas no cache: ${numeroFolha} | ${dataInicio} até ${dataFim}`);

    return res.json(resultado);

  } catch (error) {
    console.error("Erro ao buscar marcações:", error.response?.data || error.message);

    return res.status(500).json({
      erro: "Erro ao buscar marcações"
    });
  }
});

module.exports = router;