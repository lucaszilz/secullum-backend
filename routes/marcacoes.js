const express = require("express");
const axios = require("axios");

const router = express.Router();

let secullumToken = null;
const cacheMarcacoes = {};
const cacheSaldoDia = {};

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

  console.log("Token Secullum gerado automaticamente nas marcações");

  return secullumToken;
}

async function obterTokenSecullum() {
  if (!secullumToken) {
    return await gerarTokenSecullum();
  }

  return secullumToken;
}

function diferencaDias(dataInicio, dataFim) {
  const inicio = new Date(`${dataInicio}T00:00:00`);
  const fim = new Date(`${dataFim}T00:00:00`);
  const diffMs = fim - inicio;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1;
}

function converterDataBRParaISO(dataBR) {
  if (!dataBR) return null;

  const somenteData = String(dataBR).split(" - ")[0];
  const [dia, mes, ano] = somenteData.split("/");

  if (!dia || !mes || !ano) return null;

  return `${ano}-${mes}-${dia}`;
}

function converterSaldoParaMinutos(saldo) {
  if (!saldo) return 0;

  const texto = String(saldo).trim();

  if (!texto || texto === "00:00") return 0;

  const negativo = texto.startsWith("-");
  const valorLimpo = texto.replace("+", "").replace("-", "");
  const [horas, minutos] = valorLimpo.split(":").map(Number);

  if (Number.isNaN(horas) || Number.isNaN(minutos)) return 0;

  let total = (horas * 60) + minutos;

  if (negativo) {
    total *= -1;
  }

  return total;
}

function converterMinutosParaSaldo(totalMinutos) {
  const negativo = totalMinutos < 0;
  const absoluto = Math.abs(totalMinutos);

  const horas = String(Math.floor(absoluto / 60)).padStart(2, "0");
  const minutos = String(absoluto % 60).padStart(2, "0");

  if (totalMinutos === 0) {
    return "00:00";
  }

  return `${negativo ? "-" : "+"}${horas}:${minutos}`;
}

async function buscarSaldoDiaPorPeriodo({ funcionarioCpf, dataInicio, dataFim }) {
  const cpfLimpo = String(funcionarioCpf || "").replace(/\D/g, "");

  if (!cpfLimpo) {
    return {
      saldosPorData: {},
      saldoPeriodo: "00:00"
    };
  }

  const chaveCache = `${cpfLimpo}-${dataInicio}-${dataFim}`;

  if (cacheSaldoDia[chaveCache]) {
    console.log("Retornando saldo do dia do CACHE");

    return {
      ...cacheSaldoDia[chaveCache],
      origem: "cache"
    };
  }

  const dias = diferencaDias(dataInicio, dataFim);

  if (dias > 30) {
    return {
      saldosPorData: {},
      saldoPeriodo: "00:00",
      erro: "O Saldo/Dia só pode ser consultado em períodos de até 30 dias."
    };
  }

  const response = await axios.post(
    "https://pontowebintegracaoexterna.secullum.com.br/IntegracaoExterna/Calcular",
    {
      funcionarioCpf: cpfLimpo,
      dataInicial: dataInicio,
      dataFinal: dataFim,
      centrosDeCustos: []
    },
    {
      headers: {
        Authorization: `Bearer ${await obterTokenSecullum()}`,
        secullumidbancoselecionado: process.env.SECULLUM_BANCO_ID,
        "Content-Type": "application/json"
      }
    }
  );

  const colunas = response.data.Colunas || [];
  const linhas = response.data.Linhas || [];

  const indiceBTotal = colunas.indexOf("BTotal");

  const saldosPorData = {};
  let saldoPeriodoMinutos = 0;

  if (indiceBTotal >= 0) {
    for (const linha of linhas) {
      const dataISO = converterDataBRParaISO(linha.Value?.[0]);
      const saldoDia = linha.Value?.[indiceBTotal] || "00:00";

      if (dataISO) {
        const saldoFormatado = saldoDia === "00:00"
          ? "00:00"
          : saldoDia.startsWith("-") || saldoDia.startsWith("+")
            ? saldoDia
            : `+${saldoDia}`;

        saldosPorData[dataISO] = saldoFormatado;
        saldoPeriodoMinutos += converterSaldoParaMinutos(saldoFormatado);
      }
    }
  }

  const resposta = {
    saldosPorData,
    saldoPeriodo: converterMinutosParaSaldo(saldoPeriodoMinutos)
  };

  cacheSaldoDia[chaveCache] = resposta;

  console.log("Saldo do dia salvo no CACHE");

  return resposta;
}

router.get("/", async (req, res) => {
  try {
    const { numeroFolha, dataInicio, dataFim, incluirSaldoDia } = req.query;

    if (!numeroFolha || !dataInicio || !dataFim) {
      return res.status(400).json({
        erro: "Parâmetros obrigatórios: numeroFolha, dataInicio, dataFim"
      });
    }

    const chaveCacheMarcacoes = `${numeroFolha}-${dataInicio}-${dataFim}`;

    let resultado;

    if (cacheMarcacoes[chaveCacheMarcacoes]) {
      console.log("Retornando marcações do CACHE");
      resultado = cacheMarcacoes[chaveCacheMarcacoes];
    } else {
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

      console.log(
  JSON.stringify(
    marcacoesFiltradas[0],
    null,
    2
  )
);

      resultado = marcacoesFiltradas.map(item => {
        return {
          numeroFolha: item.Funcionario?.NumeroFolha || numeroFolha,
          cpf: item.Funcionario?.Cpf || "",
          data: item.Data?.split("T")[0],

          entrada1: item.Entrada1 || "",
          saida1: item.Saida1 || "",

          entrada2: item.Entrada2 || "",
          saida2: item.Saida2 || "",

          entrada3: item.Entrada3 || "",
          saida3: item.Saida3 || "",

          observacoes: item.Observacoes || "",
          saldoDia: ""
        };
      });

      cacheMarcacoes[chaveCacheMarcacoes] = resultado;

      console.log("Marcações salvas no CACHE");
    }

    let saldoPeriodo = null;
    let erroSaldoDia = null;

    if (String(incluirSaldoDia) === "true") {
      const dias = diferencaDias(dataInicio, dataFim);

      if (dias > 30) {
        erroSaldoDia = "O Saldo/Dia só pode ser consultado em períodos de até 30 dias.";
      } else {
        const funcionarioCpf = resultado.find(item => item.cpf)?.cpf;

        const saldoDiaResponse = await buscarSaldoDiaPorPeriodo({
          funcionarioCpf,
          dataInicio,
          dataFim
        });

        if (saldoDiaResponse.erro) {
          erroSaldoDia = saldoDiaResponse.erro;
        }

        saldoPeriodo = saldoDiaResponse.saldoPeriodo;

        resultado = resultado.map(item => ({
          ...item,
          saldoDia: saldoDiaResponse.saldosPorData?.[item.data] || "00:00"
        }));
      }
    }

    if (saldoPeriodo) {
  res.setHeader("X-Saldo-Periodo", saldoPeriodo);
}

if (erroSaldoDia) {
  res.setHeader("X-Erro-Saldo-Dia", encodeURIComponent(erroSaldoDia));
}

return res.json(resultado);

  } catch (error) {
    console.error(error.response?.data || error.message);

    return res.status(500).json({
      erro: "Erro ao buscar marcações"
    });
  }
});

module.exports = router;