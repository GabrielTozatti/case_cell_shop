# CaseCellShop — Respostas do Desafio Técnico

## Parte 1.A — Perguntas Conceituais

---

### Pergunta 1 — Diagnóstico, trade-offs e arquitetura alvo

#### Problema 1: Performance da vitrine

**Causa raiz.** A loja virtual consulta o ERP REST síncrono a cada `GET /products`. Cada requisição custa CPU e I/O no ERP (leitura MySQL + regras de negócio). Com milhões de acessos diários, o ERP satura e a latência degrada quadraticamente.

**Impacto.** O cliente enfrenta lentidão, aumentando o bounce rate e reduzindo a taxa de conversão. A operação sofre com timeouts e cascading failure — se o ERP cai, a loja virtual inteira fica fora. Para o negócio, isso significa perda de receita direta.

**Soluções comparadas.** Considerei três caminhos:

- **Cache-Aside com Redis** — custo baixo (um Redis), complexidade baixa, latência de ~1-5ms, esforço de 2-3 dias. Desvantagem: consistência eventual com TTL de 60s.
- **Read Replica MySQL** — latência um pouco maior (~5-20ms), consistência quase real-time, mas exige mais esforço (1-2 semanas) e custo de manutenção.
- **CDN + Cache-Control** — simples e barato, porém o risco de servir dados muito velhos é alto e não temos controle sobre a invalidação.

Optei pelo Cache-Aside com Redis, implementado em `src/modules/products/products.service.ts`. O catálogo é cacheado com TTL configurável, e o estoque é sempre lido em tempo real via `MGET` do Redis — apenas metadados como nome, preço e descrição vão para cache.

#### Problema 2: Consistência de estoque

**Causa raiz.** Quando duas ou mais requisições simultâneas leem o estoque (por exemplo, 5 unidades) antes de qualquer uma escrever o decremento, ambas aprovam a venda. É a race condition clássica de read-then-write sem atomicidade: entre a leitura e a escrita há uma janela onde outra requisição pode ler o mesmo valor.

**Impacto.** O cliente compra, o pagamento é aprovado, mas não há estoque. Isso gera insatisfação, custo operacional de reembolso e cancelamento, e dano à reputação da marca. Para o negócio, cada ocorrência significa retrabalho do time de atendimento e possível chargeback.

**Soluções comparadas.**

- **Atomic DECRBY (Redis)** — mais simples e rápido (~1ms), sem lock. O `DECRBY` é atômico, não há janela entre leitura e escrita.
- **Lock Pessimista (Redlock)** — mais complexo e lento (~10-50ms), útil para coordenar múltiplos recursos.
- **Reserva em 2 fases** (reserve → confirm) — flexível, permite expirar reservas, mas adiciona complexidade de estados.
- **Distributed Lock + checagem** — padrão conhecido, mas sofre com contenção.

Escolhi o Atomic DECRBY com rollback, implementado em `src/modules/checkout/checkout.service.ts` linhas 75-100: se o resultado for negativo, fazemos `INCRBY` para reverter e retornamos 409 Conflict. É equivalente a `UPDATE ... SET stock = stock - ? WHERE stock >= ?` em SQL, sem lock de linha.

#### Problema 3: Resiliência do checkout

**Causa raiz.** O ERP demora segundos para faturar um pedido. Se a API espera síncrona pelo retorno, o timeout da loja virtual estoura (tipicamente 30s). O cliente vê erro 500, mas o pedido pode ou não ter sido processado — um cenário de erro não-determinístico.

**Impacto.** Ocorre um falso positivo (cliente tenta de novo e duplica o pedido) ou um falso negativo (pedido perdido). Ambos geram retrabalho do time operacional e insatisfação do cliente. Para o negócio, isso significa perda de vendas legítimas ou custo com estornos.

**Soluções comparadas.**

- **Checkout Assíncrono com Fila (BullMQ)** — retorna 202 Accepted imediatamente, alta resiliência (retry, backoff, dead letter), baixo acoplamento com o ERP.
- **Síncrono com timeout alto** — implementação simples, mas experiência do usuário ruim (espera longa) e alto acoplamento.
- **Retry no cliente** — frágil e difícil de coordenar.

Implementei o checkout assíncrono com BullMQ em `src/infra/worker.ts`: o worker processa em background com 3 tentativas, backoff exponencial, atualização de status (pending → processing → completed | failed) e reposição de estoque em caso de falha terminal.

#### Arquitetura alvo (30 a 90 dias)

A arquitetura atual tem três camadas principais: a API Express, o Redis (cache de catálogo, estoque atômico, persistência de pedidos, idempotência e métricas do worker), e o Worker BullMQ. A evolução planejada segue quatro fases:

1. **Dias 1-15 (implementado):** Cache-Aside, fila assíncrona e observabilidade básica
2. **Dias 15-30:** Webhook de callback do ERP para invalidar cache de produtos sob alteração
3. **Dias 30-60:** Read model próprio em PostgreSQL sincronizado via CDC com o ERP, eliminando a dependência síncrona de leitura de catálogo. O Redis passa a ser usado apenas para cache e operações atômicas de estoque
4. **Dias 60-90:** Dead Letter Queue, OpenTelemetry, Prometheus + Grafana, rate limiting por IP, circuit breaker para ERP

A reconciliação com o ERP seria feita por um job periódico que compara os pedidos no read model com os do ERP e dispara alertas em caso de divergência.

---

### Pergunta 2 — Cache, invalidação e performance da vitrine

**Onde colocar cache e o papel de cada camada.** Usei duas camadas:

- **Redis (Cache-Aside)** — em `src/modules/products/products.service.ts`, TTL de 60s configurável via `PRODUCT_CACHE_TTL`. Reduz a carga no ERP e a latência da API.
- **Navegador do cliente** — via header `Cache-Control: public, max-age=60`. Evita requisições repetidas do mesmo usuário, reduzindo carga na própria API.

O estoque nunca vai para cache — é sempre lido em tempo real via `MGET` do Redis, garantindo que a disponibilidade seja sempre a atual mesmo que nome ou preço tenham até 60s de atraso.

**TTL, invalidação, cache-aside e fallback.** A escolha de TTL fixo de 60s se baseia na baixa frequência de alteração de preço e descrição dos produtos. O mecanismo é Cache-Aside puro:

- `GET /products` → tenta `GET catalog:all` no Redis
- **HIT:** faz o parse do JSON, marca `fromCache = true`
- **MISS:** chama o repositório do ERP (`productsRepository.findAll()`), popula o Redis com `SET EX <TTL>`, marca `fromCache = false`
- **Em ambos:** busca o estoque de cada produto via `MGET stock:*` e enriquece a resposta

Para invalidação explícita, há o método `invalidateCache()` em `products.service.ts` que deleta `catalog:all`. Em produção seria acionado por webhook do ERP. Sobre cache stampede, o TTL fixo pode causar pico de requisições no momento da expiração; para produção, adicionaríamos lock distribuído com `SET NX` para que apenas um processo popular o cache enquanto os demais servem stale data. O fallback já está implementado: se o Redis falha ao popular o cache, o serviço loga um warning e serve a resposta sem cache.

**Métricas para validar o ganho sem gerar dados obsoletos.** Uso três indicadores:

- **Hit rate** (`hit / (hit + miss)` em `src/observability/metrics.ts`) — acima de 80% indica que o cache está eficaz e a maioria das requisições não chega ao ERP
- **Latência p95 do endpoint** — antes: ~200-500ms (ERP); com cache HIT: ~2-5ms. A redução confirma a melhoria de performance
- **OversellBlocked** — se maior que zero, significa que o estoque está divergente do real. No nosso modelo o estoque nunca é cacheado, portanto deve ser sempre zero. Se aparecer, é alerta de problema na arquitetura

Dessa forma, confirmamos que a melhoria de performance não veio às custas de informação incorreta.

---

### Pergunta 3 — Observabilidade, Datadog ou equivalente

**Logs estruturados e campos obrigatórios.** Instrumentei a aplicação com pino (`src/observability/logger.ts`). Toda requisição gera logs com campos obrigatórios:

- `correlationId` — gerado ou propagado via header X-Correlation-ID (`src/middleware/correlationId.ts`)
- `spanId` — gerado localmente como `span-{timestamp}-{random}`
- `component` — identifica o módulo: products-service, checkout-service, worker, etc.
- `ts` — timestamp ISO

Quando disponíveis, também incluímos `orderId`, `productId`, `cacheKey`, `cacheResult` (HIT ou MISS), `method`, `url`, `statusCode`, `durationMs` e `error`. O correlationId permite rastrear o fluxo completo entre serviços. O orderId é adicionado nos logs do worker e do checkout via `createRequestLogger(correlationId, orderId)`.

**Métricas para cache, checkout, fila/worker e ERP.**

- **Cache:** `cache.hit` e `cache.miss` (contadores em `metrics.ts`), hit rate computado como `hit / (hit + miss)`
- **Checkout:** `checkout.enqueued` e `checkout.oversellBlocked` (contadores in-memory); `checkout.completed` e `checkout.failed` (persistidos no Redis via `HINCRBY` para visibilidade do worker)
- **Fila/Worker:** `queue.waiting` (computado como saldo entre enqueued e completed); `worker.active` (incrementado no início do processamento e decrementado no `finally`, sem vazamento mesmo em erro)
- **ERP:** Métricas indiretas — taxa de falha do worker e latência de processamento, já que o ERP é um sistema externo legado sem endpoint de métricas

**Traces e spans para GET /products e POST /checkout.** Implementei spans manuais via `spanId` local:

- **GET /products:** rota products → service.getAll → redis.get(catalog:all) → se miss, productsRepository.findAll() (ERP) e redis.set(catalog:all) → redis.mget(stock:*) → resposta
- **POST /checkout:** rota checkout → service.initiateCheckout → redis.get(idempotency:{key}) → productsRepository.findById(id) → redis.decrby(stock:{id}) → se negativo, redis.incrby (rollback) → ordersRepository.create(order) → queue.add(process-checkout) → resposta 202

Em produção, esses spans seriam substituídos por OpenTelemetry real com propagação distribuída entre serviços.

**SLI/SLO e alertas.**

| SLI | SLO | Alerta |
|---|---|---|
| cache hit rate | > 80% | < 70% → warning |
| latência p95 GET /products | < 50ms | > 200ms → warning |
| taxa de erro 5xx | < 1% | > 2% → critical |
| oversellBlocked | zero | > 0 → warning |
| backlog da fila | < 100 | > 100 → warning |
| taxa de falha do worker | < 5% | > 10% → critical |
| uptime | 99.9% | health != "ok" → pager |

**Dashboard.** Um painel único com: hit rate e latência do cache, throughput de checkout por segundo, taxa de erro 5xx, backlog da fila, workers ativos, oversells bloqueados, uptime e timestamp de inicio.

**Runbook.** Três procedimentos principais: se o hit rate cair abaixo de 70%, verificar saúde do Redis com ping e considerar aumentar TTL; se o backlog da fila ultrapassar 100, aumentar a concorrência do worker (de 5 para 20) e verificar latência do ERP; se a taxa de falha do worker exceder 10%, verificar se o ERP está online e acionar o time de plataforma.

---

### Pergunta 4 — Concorrência, estoque e idempotência

**Por que uma checagem simples de estoque é insuficiente.** O problema é a race condition de read-then-write. Em código, isso aparece como `if (stock >= quantity) { stock -= quantity; save(stock); }`. Entre a leitura do estoque (linha que avalia o `if`) e a escrita (linha do `save`), há uma janela de tempo onde outra requisição pode ler o mesmo valor. Isso acontece mesmo em Node.js single-thread porque as operações de I/O (como chamadas ao Redis) são assíncronas e entre dois `await` outras operações podem ser processadas. O resultado é que duas requisições leem estoque = 5, ambas aprovam a venda, e vendemos 10 unidades de um estoque que só tinha 5.

**Comparação das abordagens.**

- **Atomic DECRBY (escolhido)** — operação atômica no Redis, sem janela entre leitura e escrita. Mais simples e rápido (~1ms). Exige Redis na arquitetura. Implementado em `src/modules/checkout/checkout.service.ts` linhas 78-100: se negativo, faz `INCRBY` e retorna 409 Conflict.
- **Lock Pessimista (Redlock)** — coordena acesso entre múltiplos nós, porém mais complexo e lento (~10-50ms), com contenção em alto throughput.
- **Reserva em 2 fases** (reserve → confirm) — flexível, permite expirar reservas, mas adiciona complexidade de estados e requer mecanismo de expiração.
- **Distributed Lock + checagem** — padrão conhecido, mas sofre de contenção e adiciona ponto único de falha.

**Idempotência para tolerar retry, duplo clique e reprocessamento.** Cada checkout exige uma `idempotencyKey` (UUID gerado pelo cliente). O fluxo é:

1. Antes de qualquer operação de estoque ou criação de pedido, verificamos se a chave já existe no Redis (`idempotency:{key}`)
2. Se existe, retornamos o pedido já criado com header `X-Idempotent-Replay: true`, sem criar duplicata
3. A chave é salva no Redis junto com a criação do pedido, com TTL de 7 dias

Isso cobre timeout, duplo clique e reprocessamento manual — não há duplicação de estoque nem de pedido.

**Como testar contra overselling.** O teste em `tests/checkout.concurrency.test.ts` verifica:

- **Oversell prevention:** 10 requisições paralelas para estoque de 5 unidades — exatamente 5 retornam sucesso e 5 retornam "insufficient_stock"
- **Idempotência:** mesma `idempotencyKey` retorna o pedido existente sem criar outro
- **Quantidade inválida:** `quantity: 0` e `quantity: 1.5` retornam erro
- **Depleção sequencial:** estoque diminui a cada compra até zerar

---

### Pergunta 5 — Mensageria, resiliência, contrato e IA

**Antes ou depois de gravar o pedido?** Publico a mensagem na fila depois de gravar o pedido, com rollback se o enfileiramento falhar. A ordem é:

1. Cria o pedido no Redis e salva a idempotencyKey
2. Tenta adicionar o job na fila do BullMQ
3. Se `queue.add` lançar exceção → rollback manual: deleta o pedido, a idempotencyKey e replenish o estoque

Implementado em `src/modules/checkout/checkout.service.ts` linhas 116-156.

**Riscos de pedido fantasma e mensagem fantasma.**

- **Pedido fantasma** (order salva mas job não enfileira) → prevenido pelo rollback automático descrito acima
- **Mensagem fantasma** (job roda mas order não existe) → mitigada porque o worker valida a existência da ordem antes de atualizar o status; se não existe, o job falha e entra em retry
- **Job duplicado** → BullMQ com `{ jobId: orderId }` impede que o mesmo job seja adicionado duas vezes na fila
- **Retry do cliente** → idempotencyKey no Redis completa a proteção

**Retry e status de pedido.** O worker (`src/infra/worker.ts`) usa BullMQ com:

- **3 tentativas máximas** com backoff exponencial (1s, 2s, 4s)
- **Fluxo de status:** `pending` (criado, aguardando worker) → `processing` (worker iniciou) → `completed` ou `failed` (terminal)
- **Falha terminal:** após 3 tentativas, o worker restaura o estoque via `INCRBY` e marca o pedido como `failed` com mensagem de erro
- **Métrica `worker.active`:** gerenciada como net count — incrementa no início, decrementa no `finally`, sem vazamento mesmo em erro

**Contrato OpenAPI.** A especificação OpenAPI 3.1 está em `src/openapi/spec.yaml` (494 linhas), servida via Swagger UI em `http://localhost:3000/docs`. Documenta:

- **Endpoints:** `GET /products`, `POST /checkout`, `GET /orders/{orderId}/status`, `GET /health`, `GET /metrics`
- **Schemas:** Product, CheckoutRequest, CheckoutResponse, OrderStatusResponse, MetricsResponse, ErrorResponse
- **Status codes:** 200, 202, 400, 404, 409, 415, 422, 500, 503
- **Headers:** X-Cache, X-Correlation-ID, X-Idempotent-Replay
- **HATEOAS:** `_links.status` e `_links.poll` para descoberta de recursos

**Testes automatizados.** O projeto tem 4 suites de teste:

- `products.cache.test.ts` — cache HIT e MISS, TTL, invalidação, hit rate
- `checkout.concurrency.test.ts` — oversell prevention (10 requests concorrentes para 5 itens), idempotência, quantidade inválida
- `orders.status.test.ts` — ciclo de vida completo do pedido, timestamps, erros
- `worker.lifecycle.test.ts` — worker com sucesso, falha, retry, métricas, correlação
