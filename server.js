require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

let secullumToken = null;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const cacheBancoHorasEquipe = {};

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

  console.log("Token Secullum gerado automaticamente");

  return secullumToken;
}

async function obterTokenSecullum() {
  if (!secullumToken) {
    return await gerarTokenSecullum();
  }

  return secullumToken;
}

function obterDataOntem() {
  const hoje = new Date();
  hoje.setDate(hoje.getDate() - 1);
  return hoje.toISOString().split("T")[0];
}

function normalizarTexto(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function limparTexto(texto) {
  return String(texto || "")
    .replace(/\s+/g, " ")
    .trim();
}

const app = express();

app.use(cors());
app.use(express.json());

const marcacoesRoutes = require("./routes/marcacoes");

app.get("/", (req, res) => {
  res.send("Backend Secullum rodando 🚀");
});

app.post("/login", async (req, res) => {
  try {
    const { login, senha } = req.body;

    if (!login || !senha) {
      return res.status(400).json({
        erro: "Informe login e senha"
      });
    }

    const { data, error } = await supabase
      .from("Usuários")
      .select("id, nome, login, tipo, estrutura, alterar_senha")
      .eq("login", login)
      .eq("senha", senha)
      .single();

    if (error || !data) {
      return res.status(401).json({
        erro: "Login ou senha inválidos"
      });
    }

    return res.json({
      usuario: {
        id: data.id,
        nome: data.nome,
        login: data.login,
        tipo: data.tipo,
        estrutura: data.estrutura,
        alterarSenha: data.alterar_senha
      }
    });

  } catch (error) {
    console.log(error.message);

    return res.status(500).json({
      erro: "Erro ao realizar login"
    });
  }
});

app.use("/marcacoes", marcacoesRoutes);

app.get("/funcionarios", async (req, res) => {
  try {
    const response = await axios.get(process.env.SECULLUM_FUNCIONARIOS_URL, {
      headers: {
        Authorization: `Bearer ${await obterTokenSecullum()}`,
        secullumidbancoselecionado: process.env.SECULLUM_BANCO_ID
      }
    });

    const funcionarios = response.data
      .filter(f => !f.Demissao)
      .map(f => ({
        numeroFolha: f.NumeroFolha,
        nome: limparTexto(f.Nome),
        cpf: f.Cpf,
        estrutura: limparTexto(f.Estrutura?.Descricao) || null,
        admissao: f.Admissao,
        nascimento: f.Nascimento
      }));

    res.json(funcionarios);

  } catch (error) {
    console.log(error.response?.data || error.message);

    res.status(500).json({
      erro: "Erro ao buscar funcionários"
    });
  }
});

app.get("/banco-horas-equipe", async (req, res) => {
  try {
    const { estrutura, dataInicio } = req.query;
    const dataReferencia = obterDataOntem();
    const estruturaNormalizada = normalizarTexto(estrutura);
    const estruturaLimpa = limparTexto(estrutura);
    const chaveCache = `${estruturaNormalizada}-${dataInicio}-${dataReferencia}`;

    if (!estrutura || !dataInicio) {
      return res.status(400).json({
        erro: "Informe estrutura e dataInicio"
      });
    }

    if (cacheBancoHorasEquipe[chaveCache]) {
      console.log("Retornando banco de horas do CACHE");

      return res.json({
        ...cacheBancoHorasEquipe[chaveCache],
        origem: "cache"
      });
    }

    const funcionariosResponse = await axios.get(
      process.env.SECULLUM_FUNCIONARIOS_URL,
      {
        headers: {
          Authorization: `Bearer ${await obterTokenSecullum()}`,
          secullumidbancoselecionado: process.env.SECULLUM_BANCO_ID
        }
      }
    );

    const funcionarios = funcionariosResponse.data
      .filter(f => !f.Demissao)
      .filter(f => normalizarTexto(f.Estrutura?.Descricao) === estruturaNormalizada)
      .map(f => ({
        numeroFolha: f.NumeroFolha,
        nome: limparTexto(f.Nome),
        cpf: f.Cpf,
        estrutura: limparTexto(f.Estrutura?.Descricao) || null
      }));

    const resultado = [];

    for (const funcionario of funcionarios) {
      try {
        if (!funcionario.cpf) {
          resultado.push({
            ...funcionario,
            saldoBancoHoras: null,
            erro: "Funcionário sem CPF cadastrado"
          });
          continue;
        }

        const cpfLimpo = String(funcionario.cpf).replace(/\D/g, "");

        const calcularResponse = await axios.post(
          "https://pontowebintegracaoexterna.secullum.com.br/IntegracaoExterna/Calcular/SomenteTotais",
          {
            FuncionarioCpf: cpfLimpo,
            DataInicial: dataInicio,
            DataFinal: dataReferencia
          },
          {
            headers: {
              Authorization: `Bearer ${await obterTokenSecullum()}`,
              secullumidbancoselecionado: process.env.SECULLUM_BANCO_ID,
              "Content-Type": "application/json"
            }
          }
        );

        const colunas = calcularResponse.data.Colunas;
        const totais = calcularResponse.data.Totais;

        const indiceBSaldo = colunas.indexOf("BSaldo");

        resultado.push({
          numeroFolha: funcionario.numeroFolha,
          nome: funcionario.nome,
          estrutura: funcionario.estrutura,
          saldoBancoHoras: indiceBSaldo >= 0 ? totais[indiceBSaldo] : null
        });

      } catch (erroFuncionario) {
        resultado.push({
          ...funcionario,
          saldoBancoHoras: null,
          erro: erroFuncionario.response?.data || erroFuncionario.message
        });
      }
    }

    resultado.sort((a, b) => {
      const converterMinutos = (saldo) => {
        if (!saldo) return 0;

        const negativo = saldo.startsWith("-");
        const valorLimpo = saldo.replace("-", "");

        const [horas, minutos] = valorLimpo.split(":").map(Number);

        let total = (horas * 60) + minutos;

        if (negativo) {
          total = total * -1;
        }

        return total;
      };

      return converterMinutos(b.saldoBancoHoras) - converterMinutos(a.saldoBancoHoras);
    });

    const positivos = resultado.filter(f => {
      return (
        f.saldoBancoHoras &&
        !f.saldoBancoHoras.startsWith("-") &&
        f.saldoBancoHoras !== "00:00"
      );
    });

    const negativos = resultado.filter(f => {
      return f.saldoBancoHoras && f.saldoBancoHoras.startsWith("-");
    });

    const zerados = resultado.filter(f => {
      return !f.saldoBancoHoras || f.saldoBancoHoras === "00:00";
    });

    const maiorSaldo = positivos[0];
    const menorSaldo = negativos[negativos.length - 1];

    const resumo = {
      totalFuncionarios: resultado.length,
      saldoPositivo: positivos.length,
      saldoNegativo: negativos.length,
      saldoZerado: zerados.length,
      maiorSaldo: maiorSaldo?.saldoBancoHoras || "00:00",
      menorSaldo: menorSaldo?.saldoBancoHoras || "00:00"
    };

    const resposta = {
      estrutura: estruturaLimpa,
      dataInicio,
      dataFim: dataReferencia,
      origem: "secullum",
      resumo,
      funcionarios: resultado
    };

    cacheBancoHorasEquipe[chaveCache] = resposta;

    console.log("Banco de horas salvo no CACHE");

    res.json(resposta);

  } catch (error) {
    console.log(error.response?.data || error.message);

    res.status(500).json({
      erro: "Erro ao buscar banco de horas da equipe"
    });
  }
});

app.listen(3001, () => {
  console.log("Servidor rodando na porta 3001");
});