# DISTRILOG — Operação logística e WMS

Aplicativo FastAPI + JavaScript, hospedado no Render. O banco operacional
e os arquivos de evidência são persistidos no PostgreSQL do Supabase.

## Como funciona

- Recebimento com controle de volumes e amostra de 10%.
- Qualidade, retorno de Costura, Triagem, Cadastro, Etiquetagem e Estocagem.
- Alocação WMS em RM, QA, PR, ET e EC.
- RM/QA/PR usam volumes e saldo compartilhado; ET/EC registram caixas pretas e até quatro cores por casulo.
- **Mapa de endereçamento:** clique em qualquer posição para ver as referências, cores, tamanhos e saldos efetivamente vinculados. A transferência física é independente de concluir um Card; ela não altera o estágio operacional.
- **Reconciliação WMS:** Gestão pode consultar anomalias; apenas um administrador pode inativar um registro órfão após confirmar fisicamente que o endereço está vazio, com justificativa e histórico preservado.
- **Visão da Missão:** o quadro principal utiliza somente o aplicativo. O PostgreSQL grava o backlog de peças por setor na **segunda, 08h10**, a prévia acumulada de produção na **quarta, 12h00** e o resultado final imutável na **sexta, 16h00**, sempre no horário de **America/Sao_Paulo**. Após os cortes, os valores não mudam; produzido pode superar o backlog. A planilha de maio–outubro/2026 continua disponível apenas como **Histórico legado**, sem ser usada nos cálculos operacionais.

## Ambiente e segurança

Variáveis do Render:
- `SUPABASE_DATABASE_URL`: conexão PostgreSQL operacional. Obrigatória.
- `AUTH_DATABASE_URL`: opcional para separar as credenciais de autenticação, **precisa ter acesso ao mesmo projeto de dados ou operar conforme arquitetura de autenticação configurada**.
- `AUTH_SESSION_SECRET`: segredo aleatório com ao menos 32 caracteres. Obrigatório.
- `DISTRILOG_BOOTSTRAP_PASSWORD`: **apenas para primeira instalação**. Se definida, deve conter de 12 a 128 caracteres, letras e números; cria apenas o admin quando não existir. Remova-a após inicialização.
- `DB_POOL_MAX` e `AUTH_PG_POOL_MAX`: tamanho dos pools, conforme capacidade do banco.

Não são criados logins com senha `1234` automaticamente. Contas existentes
pendentes de troca foram invalidadas no projeto Supabase avaliado. Para
reativar operadores, entre como admin e use
**Cadastros → Redefinir senha de operador** (senha temporária de 12+ caracteres).
A troca de senha e o logout revogam cookies anteriores.

`/health` somente devolve 200 quando o PostgreSQL responde, e o `render.yaml`
configura deploy automático após o sucesso dos checks do GitHub Actions.
Se o serviço foi criado fora do Blueprint, confirme também no painel do Render
que a configuração **After CI Checks Pass** está ativa.

As tabelas expostas ao Supabase Data API permanecem com RLS ativado e sem
políticas de acesso direto; isso é uma postura de negação por padrão, não um
mecanismo de autorização por operador. O backend valida sessões e permissões
por ação. Não altere a conexão para `distrilog_app` (sem BYPASSRLS) sem
preparar uma migração de políticas e testar as transações em ambiente isolado.

## Migrações

Os scripts versionados ficam em `migrations/`. A criação idempotente de
tabelas operacionais também ocorre no startup. Migrações de integridade
instalaram restrições `NOT VALID` que rejeitam **novas** alocações órfãs,
mas não descartam registros legados sem card/item. Esses registros devem
ser conferidos fisicamente na Central de Endereçamento.

Não apague nem zere `distrilog.card_allocations` para corrigir a aparência
do mapa. Faça backup antes de migrações e de reconciliações administrativas.

## Visão da Missão automática — regras de apuração

- Os jobs `distrilog-mission-backlog`, `distrilog-mission-wednesday` e `distrilog-mission-friday` executam diretamente no Supabase, mesmo quando o Render está inativo. O calendário é convertido para **America/Sao_Paulo**; cada execução só é aceita no minuto operacional correto. O mecanismo é idempotente e não reescreve fotografias.
- Os registros ficam nas tabelas `distrilog.mission_weekly_runs` e `distrilog.mission_weekly_metrics`. A API autenticada `GET /api/mission/weekly?month=AAAA-MM` retorna os três cortes e distingue **agendado**, **capturado** e **não capturado**. Um corte perdido **não é reconstruído com números atuais**, para não reescrever a história.
- **Backlog:** peças dos itens atualmente atribuídos ao setor no exato instante de segunda-feira. Com carga de trabalho fracionada por referência, o estágio individual do item é consultado; Cards em trânsito e finalizados não entram. O backlog é a fotografia da carga inicial, e não o saldo ao longo da semana.
- **Produzido:** conclusão efetiva registrada nos módulos do aplicativo desde segunda 08h10: Recebimento físico, Qualidade 1 e 2, Triagem de Processamento, Processamento com quantidade por item, Etiquetagem, Estocagem, despacho para Costura (Expedição PCP) e Expedição. Os eventos são somados até o corte de quarta ou sexta. Transferir mercadoria entre endereços **não gera produzido**.
- **Unidades:** a missão calcula **peças**. Campos de volume, casulo e caixa preta não são convertidos arbitrariamente em peças. **AJUSTES** permanece com produzido “sem fonte” enquanto não houver um apontamento concluído confiável nesse fluxo; não mostrar zero inventado.
- **Fechamento:** sexta 16h congela o resultado; produção posterior ao horário de fechamento não altera o período. Quarta é uma prévia fixa, preservada mesmo depois do resultado de sexta.
- **Início da rotina:** não é possível recompor fielmente o backlog de uma segunda-feira já passada com o estado atual do Card. Ao instalar após o início da semana, a primeira fotografia legítima será a próxima segunda às 08h10, desde que o cron esteja ativo no mesmo banco operacional do Render.
- Para verificar o agendamento, consulte `SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'distrilog-mission-%';` e inspecione `cron.job_run_details` após o horário esperado. Nunca teste a captura forçando um registro real fora do período.
- **Cuidado ao homologar:** confirme que o `SUPABASE_DATABASE_URL` do Render aponta para o mesmo projeto no qual o cron foi instalado. Um Supabase conectado sem Cards não comprova que a operação do Render foi importada.

## Testes

A suíte do GitHub Actions executa verificação de sintaxe Python/JS,
testes de contrato e testes de transferência WMS em banco PostgreSQL
temporário: movimentação parcial, transferência de caixas por cor,
limite de quatro cores, rollback e reconciliação física.

Comandos locais:

```bash
pip install -r requirements.txt
pip install pytest==8.3.4
python -m compileall -q .
python -m pytest tests -q
uvicorn app:app --reload
```

Sem `TEST_DATABASE_URL`, os testes que dependem de PostgreSQL isolado
são ignorados. A suíte não substitui testes de ponta a ponta de login,
Qualidade e Recebimento no Render com dados operacionais de homologação.

## Histórico e infraestrutura

O `app.py` usa o ciclo de vida ASGI moderno `lifespan`. O banco é
PostgreSQL; referências a SQLite ainda presentes em comentários ou no
tradutor `db.py` descrevem apenas compatibilidade histórica de SQL,
não um banco local ativo. Os novos uploads genéricos e fotos da Qualidade
são salvos no Supabase; arquivos locais antigos só permanecem acessíveis
enquanto existirem no container, portanto reimporte evidências legadas
importantes caso tenham sido perdidas em deploys anteriores.
