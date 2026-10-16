# DISTRILOG — Recebimento e endereçamento WMS

O DISTRILOG usa como base operacional a lógica do repositório `Distribox-`, preservando a interface e removendo do menu Gestão: Indicadores (GOAT), Produção por Pessoa, Ferramentas de teste e Configurações. Cadastros permanece disponível.

## Fluxos importados
- Criação manual de card por referência, com grade de cores e tamanhos.
- Recebimento físico, confirmação, contagem de volumes e quantidade recebida.
- Regras de separação/conferência dos 10%.
- Cronômetro de recebimento (iniciar, pausar e retomar).
- Endereçamento WMS por RM, QA, PR, ET e EC; sugestão de posição, saldos e trilha de alocações.
- Saldo global de alocação compartilhado entre RM + QA + PR.
- Mapa físico de casulos, mapa de calor e simulador de capacidade removidos para reduzir carga; o endereçamento WMS operacional permanece independente.
- Banco único: tudo (Cards, Recebimento, Qualidade, Processamento, Endereçamento, GOAT, Devoluções etc.) é lido e gravado direto no schema `distrilog` do Supabase, sem SQLite, cópia local ou sincronização.

## Render
O serviço usa o `Dockerfile` e `render.yaml`. Configure a variável `SUPABASE_DATABASE_URL` nas variáveis do Render com a connection string PostgreSQL de um projeto Supabase **dedicado ao DISTRILOG**, caso queira login seguro e persistência compartilhada entre redeploys. Não reutilize o banco do Distribox- sem querer compartilhar cards e operações.

A variável `SUPABASE_DATABASE_URL` é obrigatória: sem ela o app não inicia. Na inicialização o app cria o schema `distrilog` e todas as tabelas (inclusive as evidências de imagem da Qualidade em `distrilog.quality_files`). Cada operação é uma transação única no Supabase; se falhar, nada é salvo pela metade. Para menor latência, mantenha o serviço do Render na mesma região do projeto Supabase e prefira a connection string do pooler (porta 6543 ou 5432).

Após salvar a variável, publique o commit mais recente em **Manual Deploy → Deploy latest commit** ou aguarde o deploy automático. A rota `/health` é o health check.

## Endereçamento operacional
As posições WMS são independentes do mapa físico de capacidade. Endereços usam casulos 01–20 e níveis A/B/C:
- RM: zona 1
- QA: zonas 1 e 2
- PR: zona 1
- ET: zona 1
- EC: zonas 1 e 2 (Feminino/Masculino)

## Local
```bash
pip install -r requirements.txt
uvicorn app:app --reload
```
