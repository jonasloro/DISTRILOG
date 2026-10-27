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
- **Visão da Missão:** histórico semanal importado da planilha e fotografia de itens por etapa diretamente do Supabase. O produzido histórico não é inferido dos dados dos Cards.

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
