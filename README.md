# CaseCellShop

Serviço desenvolvido para o desafio técnico, responsável por gerenciar catálogo de produtos, controle de estoque, checkout assíncrono e rastreamento de pedidos.

A aplicação foi construída com foco em:

- Arquitetura simples e escalável
- Proteção contra oversell
- Processamento assíncrono resiliente
- Observabilidade
- Boas práticas de engenharia back-end

---

## 🚀 Tecnologias Utilizadas

| Camada | Tecnologia | Finalidade |
| :--- | :--- | :--- |
| **Runtime** | Node.js 20 + TypeScript | Ambiente principal da aplicação |
| **Framework** | Express | API HTTP simples e performática |
| **Cache** | Redis 7 | Cache de catálogo e controle de estoque |
| **Fila** | BullMQ | Processamento assíncrono de checkout |
| **Observabilidade** | pino | Logs estruturados em JSON |
| **Testes** | Vitest | Testes unitários e integração |
| **Containerização** | Docker Compose | Infraestrutura local |

---

# 💻 Funcionalidades

## 1. Catálogo de Produtos com Cache

A API disponibiliza um endpoint de catálogo utilizando estratégia **Cache-Aside** no Redis.

### Recursos implementados

- Cache com TTL configurável
- Header `X-Cache` indicando `HIT` ou `MISS`
- Redução de carga no ERP
- Lazy population automática

---

## 2. Checkout Assíncrono

O fluxo de compra foi desenhado para evitar bloqueios síncronos e melhorar a experiência do cliente.

### Fluxo

1. Cliente envia checkout
2. Estoque é reservado atomicamente
3. Pedido é colocado na fila
4. Worker processa faturamento no ERP
5. Cliente acompanha o status do pedido

### Benefícios

- Baixa latência na API
- Retry automático
- Resiliência contra falhas do ERP
- Processamento concorrente seguro

---

## 3. Proteção Contra Oversell

A reserva de estoque utiliza operações atômicas do Redis:

```txt
DECRBY stock:{productId} {quantity}
```

Caso o resultado fique negativo:

```txt
INCRBY stock:{productId} {quantity}
```

Isso garante:

- Controle de concorrência
- Prevenção de race conditions
- Segurança mesmo com múltiplos workers

---

## 4. Idempotência

Cada checkout exige um:

```txt
idempotencyKey
```

Isso evita:

- Cobranças duplicadas
- Retry inseguro
- Duplicação de pedidos

A chave permanece armazenada no Redis por 24h.

---

## 5. Observabilidade

A aplicação possui:

- Logs estruturados
- Métricas internas
- Correlação de requests
- Métricas de cache e filas

Endpoints disponíveis:

```http
GET /metrics
```

---

# 📁 Estrutura do Projeto

A aplicação segue uma estrutura modular voltada para escalabilidade e separação de responsabilidades.

| Diretório | Responsabilidade |
| :--- | :--- |
| **`src/modules`** | Domínios da aplicação |
| **`src/infra`** | Redis, filas, providers e integrações |
| **`src/config`** | Configurações da aplicação |
| **`src/middleware`** | Middlewares HTTP |
| **`src/observability`** | Logs, métricas e tracing |
| **`src/openapi`** | Swagger/OpenAPI |
| **`tests`** | Testes automatizados |

---

# ⚙️ Configuração e Execução

## 1. Pré-requisitos

Antes de iniciar, certifique-se de possuir instalado:

- Node.js 20+
- Docker
- Docker Compose
- npm

---

## 2. Configuração das Variáveis de Ambiente

Copie o arquivo `.env.example`:

```bash
cp .env.example .env
```

---

## 3. Subir Redis

```bash
docker-compose up -d
```

---

## 4. Instalar Dependências

```bash
npm install
```

---

## 5. Executar API

```bash
npm run dev
```

A API estará disponível em:

```txt
http://localhost:3000
```

---

## 6. Executar Worker

Em outro terminal:

```bash
npm run worker
```

---

## 7. Executar Testes

```bash
npm test
```

---

# 📚 Documentação da API

Swagger UI:

```txt
http://localhost:3000/docs
```

---

# 🌐 Endpoints

## `GET /products`

Retorna catálogo de produtos utilizando cache Redis.

### Exemplo

```bash
curl http://localhost:3000/products
```

### Headers

```txt
X-Cache: HIT
X-Cache: MISS
```

---

## `POST /checkout`

Realiza reserva de estoque e envia pedido para processamento assíncrono.

### Exemplo

```bash
curl -X POST http://localhost:3000/checkout \
  -H "Content-Type: application/json" \
  -d '{
    "productId": "prod-001",
    "quantity": 2,
    "idempotencyKey": "uuid-unico"
  }'
```

### Resposta

```json
{
  "orderId": "ord-550e8400",
  "status": "pending",
  "message": "Order accepted and queued for processing",
  "_links": {
    "status": "/orders/ord-550e8400/status"
  }
}
```

---

## `GET /orders/:orderId/status`

Consulta o status do pedido.

### Exemplo

```bash
curl http://localhost:3000/orders/ord-550e8400/status
```

### Possíveis estados

```txt
pending
processing
completed
failed
```

---

## `GET /metrics`

Retorna métricas internas da aplicação.

### Exemplo

```bash
curl http://localhost:3000/metrics
```

---

# 🧠 Decisões Técnicas

## Cache-Aside

Foi utilizada a estratégia:

```txt
Cache-Aside + TTL fixo
```

### Motivos

- Controle manual do cache
- Menor acoplamento com ERP
- Simplicidade operacional

### Trade-off

Produtos podem permanecer desatualizados por até 60 segundos, porém o oversell continua protegido no checkout.

---

## Checkout Assíncrono

A API retorna:

```http
202 Accepted
```

O processamento acontece via worker em background.

### Benefícios

- Menor latência
- Maior escalabilidade
- Retry automático
- Resiliência contra timeout

---

## BullMQ

Escolhido para:

- Retry com backoff
- Persistência
- Concorrência
- Integração simples com Redis

---

## Observabilidade

A aplicação utiliza:

- `pino`
- métricas in-memory
- correlationId
- spanId local

Em produção:

- OpenTelemetry
- Datadog APM
- Prometheus
- Grafana

---

# 📈 Observabilidade e Monitoramento

## Métricas monitoradas

- Cache hit rate
- Jobs na fila
- Tempo de processamento
- Falhas de checkout
- Oversell bloqueado

---

## Alertas recomendados

### Cache hit rate baixo

```yaml
avg(last_5m):casecellshop.cache.hit_rate < 70
```

### Fila congestionada

```yaml
max(last_2m):casecellshop.queue.waiting > 100
```

### Taxa de falha elevada

```yaml
avg(last_10m):failed / enqueued > 0.05
```

---

# 🐳 Docker

A infraestrutura local utiliza:

- Redis
- Docker Compose

Subida rápida:

```bash
docker-compose up -d
```

---

# 🧪 Testes

O projeto utiliza:

```txt
Vitest
```

Tipos de testes:

- Unitários
- Integração
- Fluxos de checkout
- Proteção contra oversell

---

# 🐱‍🏍 Melhorias Futuras

Caso o projeto evoluísse para produção, algumas melhorias seriam:

- PostgreSQL para persistência de pedidos
- Dead Letter Queue
- Webhooks/WebSocket
- OpenTelemetry real
- Prometheus + Grafana
- Rate limiting
- JWT/Auth middleware
- Circuit breaker para ERP
- Kubernetes + autoscaling
- CI/CD pipeline

---

# 📌 Considerações Finais

O objetivo principal deste projeto foi demonstrar:

- Arquitetura back-end moderna
- Controle de concorrência
- Resiliência
- Processamento assíncrono
- Observabilidade
- Organização de código
- Boas práticas de engenharia

Mesmo sendo um desafio técnico, a aplicação foi estruturada pensando em cenários reais de produção e evolução futura.