# provider-agy

Provider **OpenAI-compatible** local que usa o backend do **Antigravity CLI (`agy`)** já logado na sua conta, para codar com o **omp (Oh My Pi)** e outros clientes que falem OpenAI Chat Completions.

O cliente fala com um servidor local; o servidor traduz para o mesmo protocolo que o `agy` usa no Cloud Code do Google. Nenhum header de “cliente alternativo” é inventado: o fingerprint HTTP replica o do `agy`.

> Projeto não oficial, sem vínculo com o Google. Use por sua conta e risco.

## Como funciona

1. Lê o token OAuth da mesma entrada de keyring do `agy` (`gemini:antigravity`) e guarda uma cópia em um cofre local multi-contas.
2. Quando o access token expira, renova com o client OAuth do `agy` (configurado localmente, fora do repositório) e salva o token renovado no cofre.
3. Envia `POST https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse` com:
   - o mesmo `User-Agent` do `agy` (`antigravity/cli/1.5.9 (...)`),
   - o mesmo envelope (`project`, `requestId`, `request`, `model`, `userAgent`, `requestType`),
   - os mesmos `labels` internos (`model_enum`, `cascade_id`, `trajectory_id`, etc.),
   - `generationConfig` por modelo (`thinkingLevel` no Gemini, `thinkingBudget` no Claude/GPT-OSS).
4. Traduz mensagens e tools entre OpenAI e o formato Gemini/Claude do Cloud Code, preservando:
   - `functionCall.id` e `functionResponse.id` (obrigatórios no Claude),
   - `thoughtSignature` (obrigatório no Gemini 3 em turnos com tool call), persistido em `~/.provider-agy/state.json` para sobreviver a reinícios,
   - streaming SSE, tool calls, `reasoning_content` e usage.

Sessões criadas antes da persistência, ou cujo tool call antigo não tem assinatura, têm esse par `functionCall`/`functionResponse` descartado no reenvio ao Gemini em vez de devolver 400.

## Requisitos

- **Windows** com `agy` instalado e **logado** (`agy -p "ok"` deve responder). A leitura do keyring usa a API de Credenciais do Windows.
- Node.js 18+ (testado com Node 24).
- `omp` 18.x (opcional; qualquer cliente OpenAI-compatible serve).

## Configuração rápida com um agente do omp

Copie o prompt abaixo e cole em uma sessão do omp (de preferência com a pasta deste projeto como diretório de trabalho). Ele foi escrito para um agente com acesso ao shell configurar o provider, a extensão, as contas e validar tudo:

```text
Configure o provider-agy nesta máquina e deixe o omp pronto para usá-lo.

Contexto: este é o repositório do provider-agy (se não estiver nele, clone
https://github.com/dilneiss/omp-agy-provider-proxy.git). O provider é
OpenAI-compatible em http://127.0.0.1:8788/v1 e sobe automaticamente pelo omp
graças a uma extensão.

Faça, nesta ordem:

1. Confirme que o agy está instalado e logado com `agy -p "ok"`. Se falhar,
   pare e me peça para autenticar com `agy acp --login`.
2. Verifique se existe ~/.provider-agy/oauth.json ou se AGY_OAUTH_CLIENT_ID e
   AGY_OAUTH_CLIENT_SECRET estão definidos. Se não existirem, me peça os
   valores do client OAuth embutido no agy; não invente valores, não imprima
   segredos e crie o arquivo com permissão restrita.
3. Rode `npm run install:omp` para instalar a extensão de auto-start.
4. Garanta em ~/.omp/agent/models.yml um provider `agy` com:
   baseUrl: http://127.0.0.1:8788/v1
   api: openai-completions
   auth: none
   e os modelos gemini-3.8-flash-high/medium/low (contextWindow 1048576,
   maxTokens 65536), claude-sonnet-4-6 e claude-opus-4-6-thinking
   (contextWindow 250000, maxTokens 64000), gpt-oss-120b-medium
   (contextWindow 131072, maxTokens 32768). Faça backup antes de editar.
5. Rode `npm run accounts -- add` e depois `npm run accounts -- list`.
6. Suba o provider com `npm start` em background, espere /health responder e
   teste um POST em /v1/chat/completions com o modelo gemini-3.8-flash-high.
7. Rode `omp models agy` e confirme que os 6 modelos aparecem.
8. Não faça commit de accounts.json, oauth.json, state.json, tokens ou logs.
   Não exponha e-mails, tokens ou quotas reais na sua resposta.

No final, resuma: contas importadas, quota por modelo, se o auto-start está
instalado e o resultado do teste de geração.
```

## Instalação

```bash
git clone https://github.com/dilneiss/omp-agy-provider-proxy.git
cd omp-agy-provider-proxy
npm start
```

Não há dependências externas: `npm start` roda direto com o Node. Na primeira execução, o provider importa automaticamente a conta que estiver logada no `agy`.

O servidor escuta em `http://127.0.0.1:8788/v1`. Para parar, use `Ctrl+C`.

### Configurar o client OAuth

O refresh do token usa o mesmo client OAuth embutido no binário do `agy`. Essas credenciais **não ficam neste repositório**; configure uma das opções abaixo:

**Opção A — arquivo local (recomendado):** crie `~/.provider-agy/oauth.json`:

```json
{
  "clientId": "<id>.apps.googleusercontent.com",
  "clientSecret": "GOCSPX-<secret>"
}
```

**Opção B — variáveis de ambiente:**

```bash
AGY_OAUTH_CLIENT_ID='<id>.apps.googleusercontent.com' \
AGY_OAUTH_CLIENT_SECRET='GOCSPX-<secret>' \
npm start
```

Os dois valores estão embutidos no executável do `agy` instalado na sua máquina. Localize o binário com `where agy` (Windows) e extraia as strings `*.apps.googleusercontent.com` e `GOCSPX-...` com a ferramenta que preferir (`strings`, editor hexadecimal etc.). O arquivo `oauth.json` fica fora do repositório e é ignorado pelo Git.

Sem essas credenciais o provider continua funcionando com o access token atual até ele expirar; depois disso o refresh falha com uma mensagem explicando o que configurar.

O cofre de contas e o `oauth.json` ficam em `~/.provider-agy/` (ou em `AGY_STATE_DIR`).

## Uso com o omp

Em um terminal, deixe o provider rodando:

```bash
npm start
# ou, no Windows:
start.cmd
```

Em outro terminal:

```bash
omp --model agy/gemini-3.8-flash-high
```

Ou use o launcher que sobe o provider se necessário e abre o omp:

```bash
omp-agy.cmd
```

### Iniciar o provider automaticamente pelo omp

O `models.yml` do omp não inicia servidores, mas o omp carrega extensões. Este projeto inclui uma extensão que sobe o provider na primeira sessão e mostra os avisos de troca de conta:

```bash
npm run install:omp
```

O instalador:

- copia `omp-extension/provider-agy.ts` para `~/.omp/agent/extensions/`;
- grava o caminho deste projeto em `~/.provider-agy/config.json`.

Reinicie o omp. Na próxima sessão, se o provider ainda não estiver rodando, a extensão executa `node server.js` em segundo plano e avisa no omp. Se já estiver rodando, ela apenas se conecta. O servidor fica ativo depois que o omp fecha, para a próxima sessão e para outros clientes.

Para descobrir os modelos:

```bash
omp models agy
```

Modelos expostos (os mesmos `agy models`):

| id | nome | contexto | saída |
|---|---|---|---|
| `gemini-3.8-flash-high` | Gemini 3.8 Flash (High) | 1M | 64K |
| `gemini-3.8-flash-medium` | Gemini 3.8 Flash (Medium) | 1M | 64K |
| `gemini-3.8-flash-low` | Gemini 3.8 Flash (Low) | 1M | 64K |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 (Thinking) | 250K | 64K |
| `claude-opus-4-6-thinking` | Claude Opus 4.6 (Thinking) | 250K | 64K |
| `gpt-oss-120b-medium` | GPT-OSS 120B (Medium) | 128K | 32K |

### Registrar no omp

Registre um provider no `~/.omp/agent/models.yml` apontando para `http://127.0.0.1:8788/v1` com `api: openai-completions` e os ids da tabela acima. Exemplo de bloco (ajuste ao formato da sua versão do omp):

```yaml
agy:
  baseUrl: http://127.0.0.1:8788/v1
  api: openai-completions
  models:
    - gemini-3.8-flash-high
    - gemini-3.8-flash-medium
    - gemini-3.8-flash-low
    - claude-sonnet-4-6
    - claude-opus-4-6-thinking
    - gpt-oss-120b-medium
```

Para tornar o modelo padrão do omp:

```bash
omp config set modelRoles '{"default":"agy/gemini-3.8-flash-high"}'
```

> Isso faz todo `omp` depender do provider local estar rodando. Se preferir, use `--model agy/...` só quando quiser.

## Multi-contas e fallback automático

O provider mantém um cofre local em `~/.provider-agy/accounts.json` com todas as contas que você importar. O keyring do `agy` continua sendo a fonte da conta “atual”; o cofre é independente e guarda as demais.

Ao subir, o provider importa automaticamente a conta que estiver no keyring. Assim você pode trocar de conta no `agy` sem perder o token que já estava salvo.

### Adicionar outra conta sem perder a atual

```bash
# 1. guarda a conta logada agora
npm run accounts -- add

# 2. entre na outra conta pelo próprio agy (/login na TUI ou agy acp --login)

# 3. importa a nova conta; a anterior continua no cofre
npm run accounts -- add

# 4. confira
npm run accounts -- list
npm run accounts -- quota
```

O comando é idempotente: importar a mesma conta de novo atualiza o token dela em vez de criar duplicata.

### Comandos de contas

| comando | efeito |
|---|---|
| `npm run accounts -- list` | lista contas, projeto e quota; marca a ativa com `*` |
| `npm run accounts -- add [nome]` | importa a conta logada no `agy` para o cofre |
| `npm run accounts -- use <email-ou-índice>` | faz o `agy` usar essa conta (grava o blob no keyring) |
| `npm run accounts -- remove <email-ou-índice>` | remove do cofre sem mexer no keyring |
| `npm run accounts -- unblock` | libera o provider depois de um bloqueio por banimento/suspensão |
| `npm run accounts -- quota` | consulta a quota real de cada conta e modelo |
| `npm run accounts -- login` | mostra o passo a passo acima |
| `npm run quota` | atalho de diagnóstico de quota usando o cofre inteiro |

Exemplos:

```bash
npm run accounts -- add
npm run accounts -- add trabalho
npm run accounts -- list
npm run accounts -- use 2
npm run accounts -- use conta@exemplo.com
npm run accounts -- remove conta@exemplo.com
```

Saída típica do `list` (dados apenas ilustrativos):

```text
Contas no cofre (2):
* 1. conta-a@exemplo.com
     projeto: aicode-consumers
     quota: flash-high=95% sonnet-4-6=0%
  2. conta-b@exemplo.com
     projeto: aicode-consumers

* = conta ativa no provider
```

### Como o roteamento funciona

- O provider tenta primeiro uma conta cujo **reset já passou**; se não houver, tenta a **conta ativa**. Se ela responder, continua ativa (sticky).
- Quando o horário de reset de uma conta esgotada passa, ela volta para a frente da fila na próxima requisição. Se ainda estiver sem quota, recebe outro 429 e o provider segue para a próxima.
- Em **429 de quota** (`QUOTA_EXHAUSTED`, `quotaResetTimeStamp` ou mensagem de “individual quota”), a conta é marcada como esgotada **para aquele modelo** até o horário de reset e o provider tenta a próxima conta automaticamente.
- O fallback é **por modelo**: Claude esgotado não impede o Gemini, e vice-versa.
- Se a conta responder com sucesso, ela vira a ativa e a marcação de esgotada é removida.
- Um **429 genérico** (sem detalhes de quota, típico de entrada grande no Gemini) **não** troca de conta: trocar não resolveria e queimaria as demais.
- Um **401** força o refresh do token daquela conta e repete uma vez. Se continuar inválida, a conta é marcada como inválida e o provider passa para a próxima.
- **5xx** tem um retry por conta antes de passar para a próxima.
- Se todas as contas estiverem sem quota, a resposta é `429` com o horário da próxima liberação. Se não houver nenhuma conta utilizável, é `503`.

O status das contas aparece em:

```bash
curl http://127.0.0.1:8788/health
curl http://127.0.0.1:8788/v1/accounts
```

### Banimento, suspensão e bloqueio global

O provider valida os erros do Cloud Code (tanto HTTP quanto eventos SSE) antes de tentar outra conta. Se a mensagem indicar banimento, suspensão, conta desativada, violação de termos ou abuso, ele:

- **para imediatamente** a requisição e **não tenta nenhuma outra conta**;
- grava o bloqueio em `~/.provider-agy/accounts.json`, então ele sobrevive a reinícios do provider;
- registra um evento `blocked` e a extensão mostra um aviso em **vermelho** (`error`) na TUI do omp;
- passa a responder `403` em todas as novas requisições, sem chamar o Google.

Exemplo do aviso:

```text
🛑 BLOQUEIO DE CONTAS — provider parado
Conta: conta-a@exemplo.com
Motivo: Your account has been suspended for violating the Terms of Service
Desde: 16/11/2026, 00:21
Nenhuma conta será tentada. Resolva a situação com o Google e rode:
npm run accounts -- unblock
```

Depois de resolver com o Google, libere manualmente:

```bash
npm run accounts -- unblock
npm run accounts -- list
```

O estado também aparece em `GET /health` e `GET /v1/accounts` no campo `blocked` (ou `null`). Erros de quota, 429 por entrada grande e bloqueios de safety do modelo **não** disparam esse bloqueio — só padrões de banimento/suspensão/violação.

### Avisos de troca de conta no omp

A extensão consulta `GET /v1/accounts/events` a cada 2 segundos e mostra uma notificação na TUI quando a conta muda. Exemplo:

```text
provider-agy trocou de conta (claude-sonnet-4-6)
Motivo: quota esgotada
De: conta-a@exemplo.com | 0% restante | reset: 16/11/2026 03:52
Para: conta-b@exemplo.com | 85% restante | reset: 16/11/2026 04:20
```

Quando a conta anterior é liberada e o provider volta para ela:

```text
provider-agy: conta liberada, voltando para conta-a@exemplo.com
Modelo: claude-sonnet-4-6
Quota atual: 100% restante | reset: 16/11/2026 05:20
```

O motivo pode ser `quota`, `invalid` (token/conta recusados), `error` (falha temporária) ou `blocked` (banimento/suspensão, mostrado em vermelho). As quotas do aviso são atualizadas no momento da troca; se a consulta falhar, aparece a última leitura conhecida ou “sem leitura”. Os avisos aparecem apenas em sessões interativas do omp; em `-p`/RPC eles não são exibidos. Ao abrir uma sessão com o provider já bloqueado, a extensão mostra o aviso vermelho na hora.

O mesmo histórico fica disponível para qualquer cliente:

```bash
curl 'http://127.0.0.1:8788/v1/accounts/events?since=0'
# since=-1 retorna só o cursor atual, sem eventos antigos
curl 'http://127.0.0.1:8788/v1/accounts/events?since=-1'
```

### Status periódico da conta

A cada **10 requisições bem-sucedidas**, o provider atualiza a quota e emite um evento `status`. A extensão mostra um banner de acompanhamento:

```text
📊 provider-agy — status da conta (10 requisições)
Conta: conta-a@exemplo.com
Modelo: gemini-3.8-flash-high
Quota: 83% restante | reset: 16/11/2026, 04:20
Requisições nesta conta: 42
```

O contador é por processo do provider; `Requisições nesta conta` é o total acumulado daquela conta no cofre. Para mudar o intervalo (por exemplo, para testar a cada 1):

```bash
AGY_STATUS_EVERY=1 npm start
```

O padrão é `10`. O status também aparece no log do provider e em `GET /v1/accounts/events`.

### Cofre e segurança dos tokens

- Arquivo: `~/.provider-agy/accounts.json` (ou `AGY_STATE_DIR/accounts.json`).
- Guarda token de acesso, refresh token, e-mail de identificação, projeto e quota de cada conta.
- No Windows, o arquivo recebe ACL restrita ao seu usuário (`icacls`).
- O cofre fica **fora do repositório** e `accounts.json`/`state.json`/`oauth.json` estão no `.gitignore`. Nunca faça commit dele.
- `npm run accounts -- use` é a única operação que altera o keyring do `agy`; o uso normal do provider não mexe nele.

## Limites: contexto, requisição e quota

Há três limites diferentes — não confunda a janela de contexto com a cota:

| limite | valor observado |
|---|---|
| Janela de contexto Gemini 3.8 Flash | **1.048.576** tokens (1M) |
| Janela de contexto Claude Sonnet/Opus 4.6 | **250.000** tokens |
| Janela de contexto GPT-OSS 120B | **131.072** tokens (128K) |
| Saída máxima Gemini / Claude / GPT-OSS | 65.536 / 64.000 / 32.768 |
| Entrada por requisição na rota Cloud Code | **~40k tokens** (acima disso: 429) |
| Quota | por modelo, com `remainingFraction` e `resetTime` |

O limite de ~40k tokens não é a janela do modelo: é um teto prático da rota/plano. Nos testes, ~140k caracteres (~39,8k tokens) passaram e ~160k (~45k) falharam, mesmo com quota sobrando. Um prompt cheio de skills/MCP no omp pode chegar a ~174 KB (~46k tokens), então não passaria sem ajuste.

Para consultar a quota real (não gasta quota de geração):

```bash
npm run quota
# ou
npm run accounts -- quota
```

O backend informa `remainingFraction` e `resetTime` por modelo. Modelos sem `remainingFraction` estão com 0 restante até o reset informado. O mesmo Claude esgotado retorna 429 também no `agy` oficial (`agy --model claude-sonnet-4-6 -p='OK'`); o `agy` continua funcionando no Gemini porque a quota é separada por modelo.

### Ajuste automático de contexto

Para funcionar com o omp cheio de skills, o provider impõe um orçamento conservador (padrão **38k tokens**):

- remove turnos antigos inteiros (sem quebrar pares `functionCall`/`functionResponse`);
- se ainda faltar espaço, trunca a **cauda** do system prompt (catálogo de skills/MCP), preservando o começo, que contém as instruções principais;
- registra o ajuste no stderr e segue.

Se você não precisa de todas as skills/MCP no omp, isso também reduz bastante o prompt:

```bash
omp --model agy/claude-sonnet-4-6 --no-skills --no-rules --no-context-files --no-extensions
```

## Variáveis de ambiente

| variável | padrão | efeito |
|---|---|---|
| `AGY_PROVIDER_HOST` | `127.0.0.1` | endereço local do servidor |
| `AGY_PROVIDER_PORT` | `8788` | porta local |
| `AGY_PROVIDER_URL` | `http://127.0.0.1:8788` | URL usada pela extensão do omp |
| `AGY_STATUS_EVERY` | `10` | intervalo de requisições para o banner de status da conta |
| `AGY_PROVIDER_DIR` | lido de `~/.provider-agy/config.json` | pasta do provider que a extensão deve iniciar |
| `AGY_NODE` | `node` | executável usado pela extensão para subir o servidor |
| `AGY_MAX_INPUT_TOKENS` | `38000` | orçamento de tokens de entrada por requisição |
| `AGY_TRIM` | `1` | `0` desabilita o ajuste de contexto (pode tomar 429) |
| `AGY_PROJECT` | `aicode-consumers` | projeto enviado ao Cloud Code |
| `AGY_STATE_DIR` | `~/.provider-agy` | cofre de contas, `oauth.json` e assinaturas de tool calls |
| `AGY_ACCESS_TOKEN` | — | usa um token fixo e ignora keyring/cofre |
| `AGY_KEYRING_TARGET` | `gemini:antigravity` | entrada do Credential Manager usada pelo `agy` |
| `AGY_OAUTH_CLIENT_ID` | — | client OAuth usado no refresh (ou use `oauth.json`) |
| `AGY_OAUTH_CLIENT_SECRET` | — | secret OAuth usado no refresh (ou use `oauth.json`) |
| `AGY_CLOUD_CODE_HOST` | `daily-cloudcode-pa.googleapis.com` | host do Cloud Code |
| `AGY_DEBUG_FC` | — | `1` loga os `functionCall` recebidos |

## Verificação rápida

```bash
# credencial do agy funcionando?
agy -p "ok"

# servidor e contas
curl http://127.0.0.1:8788/health
curl http://127.0.0.1:8788/v1/accounts
curl http://127.0.0.1:8788/v1/accounts/events?since=-1
curl http://127.0.0.1:8788/v1/models

# request não-streaming
curl -s -X POST http://127.0.0.1:8788/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gemini-3.8-flash-high","messages":[{"role":"user","content":"Responda apenas OK"}],"stream":false}'

# request streaming
curl -N -X POST http://127.0.0.1:8788/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gemini-3.8-flash-high","messages":[{"role":"user","content":"Responda apenas OK"}],"stream":true}'
```

Fluxos validados neste projeto:

- leitura, criação e edição de arquivos via tool calls com Gemini e Claude;
- streaming SSE, `functionCall`, `functionResponse`, `thoughtSignature` e usage;
- importação de conta do keyring para o cofre;
- fallback automático quando a conta ativa está inválida;
- evento de troca de conta com conta anterior, motivo, reset e quota da conta nova;
- retorno prioritário à conta anterior depois do horário de reset;
- bloqueio global imediato ao detectar banimento/suspensão, sem tentar outra conta, com aviso vermelho e `unblock` manual;
- banner periódico de status da conta a cada 10 requisições, com quota e reset atualizados;
- nenhuma janela de terminal visível: keyring e `icacls` rodam ocultos, e o `icacls` não é repetido a cada gravação;
- início automático do provider pela extensão do omp, inclusive com o servidor parado (`omp -p` respondeu sem `npm start`);
- resposta 429 com horário de reset quando todas as contas estão sem quota para o modelo.

## Diagnóstico

| sintoma | causa provável | o que fazer |
|---|---|---|
| `CredRead failed` / keyring não encontrado | `agy` não está logado nesta máquina | rode `agy -p "ok"` e faça login |
| `client OAuth do agy não configurado` | faltam as credenciais de refresh | crie `~/.provider-agy/oauth.json` ou defina `AGY_OAUTH_CLIENT_ID`/`AGY_OAUTH_CLIENT_SECRET` |
| `invalid_grant` em uma conta | refresh token revogado/expirado | faça login de novo no `agy` e rode `npm run accounts -- add` |
| `429 QUOTA_EXHAUSTED` | quota do modelo esgotada | aguarde o `resetTime` ou adicione outra conta ao cofre |
| `429` sem detalhes, em prompt grande | limite de entrada por requisição (~40k tokens) | reduza `AGY_MAX_INPUT_TOKENS`, remova skills/MCP ou diminua o contexto |
| aviso vermelho de contas bloqueadas | o Google recusou uma conta por banimento/suspensão | resolva com o Google e rode `npm run accounts -- unblock` |
| `403 BLOQUEIO DE SEGURANÇA` em toda requisição | bloqueio global ativo no cofre | `npm run accounts -- list` e, após resolver, `npm run accounts -- unblock` |
| `nenhuma conta disponível` | cofre vazio ou todas inválidas | `npm run accounts -- list` e `npm run accounts -- add` |
| porta 8788 ocupada | outro provider/processo rodando | pare o processo ou use `AGY_PROVIDER_PORT=8790` |
| provider não sobe sozinho no omp | extensão não instalada ou caminho antigo | rode `npm run install:omp` e reinicie o omp |
| aviso de troca não aparece | sessão `-p`/RPC ou extensão não carregada | use a TUI e confira `/extensions` no omp |
| extensão instalada mas servidor não encontra | projeto movido/renomeado | rode `npm run install:omp` de novo |
| janelas de terminal piscando a cada request | versão antiga rodando `icacls` em cada save | reinicie o provider na versão atual; os subprocessos agora são ocultos e o `icacls` roda no máximo uma vez por arquivo |

Para parar um processo antigo na porta (Windows):

```bash
netstat -ano | findstr :8788
taskkill /PID <pid> /F
```

## Estrutura do projeto

```text
server.js                     servidor HTTP, tradução OpenAI <-> Cloud Code, streaming e tools
lib/accounts.js               cofre multi-contas, refresh OAuth, quota, seleção e fallback
tools/accounts.js             CLI de contas (list/add/use/remove/quota/login)
tools/quota.js                diagnóstico de quota usando o cofre
tools/install-omp.js          instala a extensão que sobe o provider automaticamente
tools/keyring.ps1             leitura/escrita do Credential Manager do Windows
omp-extension/provider-agy.ts extensão do omp: auto-start e avisos de troca de conta
start.cmd                     inicia o provider no Windows
omp-agy.cmd                   sobe o provider se necessário e abre o omp
```

## Aviso

- O repositório não contém tokens de conta. O cofre fica na sua pasta de usuário e nunca deve ser commitado.
- O client OAuth usado é o mesmo embutido no binário distribuído do `agy`, mas **não é distribuído neste repositório**: você o configura em `~/.provider-agy/oauth.json` ou pelas variáveis `AGY_OAUTH_CLIENT_ID`/`AGY_OAUTH_CLIENT_SECRET`.
- Usar a credencial do Antigravity fora do cliente oficial pode contrariar os termos do serviço. O fingerprint replica o `agy`, mas isso não garante ausência de bloqueios.
- O limite de ~40k tokens e o formato do Cloud Code são do backend e podem mudar sem aviso.

## Autenticando contas do Gemini

Quem autentica é o próprio `agy`; o provider apenas importa o token que já está no keyring. O fluxo completo é:

### Primeira conta

```bash
# 1. abra o agy e faça login pelo Google
agy
# dentro da TUI, rode:
#   /login
# escolha a conta Google com acesso ao Antigravity/Gemini Code Assist

# alternativa sem TUI (login interativo e sai):
agy acp --login

# 2. confirme que a conta responde
agy -p "ok"

# 3. importe para o cofre do provider
npm run accounts -- add
npm run accounts -- list
npm run quota
```

O `add` guarda no cofre o access token, o refresh token e o e-mail da conta. A partir daí o provider renova o token sozinho e o `agy` pode continuar sendo usado normalmente.

### Adicionar outra conta sem perder a primeira

O keyring do Windows guarda **uma conta por vez**. O cofre é o que preserva as anteriores:

```bash
# 1. garanta que a conta atual está salva
npm run accounts -- add

# 2. troque de conta no agy
agy
# na TUI: /login e escolha a outra conta Google
# (se o agy não oferecer troca direta, saia e entre de novo com a outra conta)

# 3. confirme e importe a nova
agy -p "ok"
npm run accounts -- add

# 4. veja as duas e suas quotas
npm run accounts -- list
npm run quota
```

O provider passa a alternar sozinho entre elas quando a quota de uma acaba. Para o `agy` voltar a usar uma conta específica do cofre:

```bash
npm run accounts -- use conta@exemplo.com
# ou pelo índice mostrado no list:
npm run accounts -- use 2
agy -p "ok"
```

### Conta sem acesso ou token expirado

Se o login do Google não tiver acesso ao Antigravity/Gemini Code Assist, o `agy` falha antes de o provider entrar. Se o refresh token for revogado, o provider marca a conta como inválida e usa outra; para recuperar:

```bash
agy acp --login          # faça login de novo
npm run accounts -- add  # atualiza o token da mesma conta no cofre
npm run accounts -- list # confirme que ela não está mais marcada como inválida
```

A quota é **por modelo e por conta**. `npm run quota` mostra `remainingFraction` e `resetTime` de cada modelo; quando uma conta esgota, o provider troca e exibe o banner no omp, voltando para a conta anterior assim que o reset passa.
