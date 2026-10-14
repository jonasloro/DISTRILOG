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
- Supabase como fonte persistente de Cards, Recebimento e Qualidade; o SQLite local é mantido apenas como cache de compatibilidade para módulos que ainda usam consultas SQLite.

## Render
O serviço usa o `Dockerfile` e `render.yaml`. Configure a variável `SUPABASE_DATABASE_URL` nas variáveis do Render com a connection string PostgreSQL de um projeto Supabase **dedicado ao DISTRILOG**, caso queira login seguro e persistência compartilhada entre redeploys. Não reutilize o banco do Distribox- sem querer compartilhar cards e operações.

A Qualidade exige essa variável e bloqueia gravações se o Supabase estiver ausente ou indisponível; ela não confirma inspeções, resultados ou cronômetros apenas no SQLite local. Na inicialização, o app cria as tabelas persistentes da Qualidade (`outlog_quality_*`), incluindo evidências de imagem na tabela `outlog_quality_files`, e tenta migrar registros legados locais somente quando o armazenamento remoto de Qualidade ainda está vazio. As operações de Qualidade gravam primeiro no Supabase e tratam conflitos de concorrência como erro, sem apresentar a gravação como concluída.

Sem essa variável, os demais fluxos que ainda possuem modo local podem continuar usando SQLite e o endereçamento gera posições localmente, mas o login seguro fica indisponível e os dados locais podem ser perdidos quando o container é recriado. Não deixamos uma senha administrativa fixa habilitada no serviço online.

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
