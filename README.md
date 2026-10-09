# DISTRILOG — Recebimento e endereçamento WMS

O DISTRILOG usa como base operacional a lógica do repositório `Distribox-`, preservando a interface e removendo do menu Gestão: Indicadores (GOAT), Produção por Pessoa, Ferramentas de teste e Configurações. Cadastros permanece disponível.

## Fluxos importados
- Criação manual de card por referência, com grade de cores e tamanhos.
- Recebimento físico, confirmação, contagem de volumes e quantidade recebida.
- Regras de separação/conferência dos 10%.
- Cronômetro de recebimento (iniciar, pausar e retomar).
- Endereçamento WMS por RM, QA, PR, ET e EC; sugestão de posição, saldos e trilha de alocações.
- Saldo global de alocação compartilhado entre RM + QA + PR.
- SQLite local para testes isolados e espelhamento/persistência compartilhada quando Supabase estiver configurado.

## Render
O serviço usa o `Dockerfile` e `render.yaml`. Configure a variável `SUPABASE_DATABASE_URL` nas variáveis do Render com a connection string PostgreSQL de um projeto Supabase **dedicado ao DISTRILOG**, caso queira login seguro e persistência compartilhada entre redeploys. Não reutilize o banco do Distribox- sem querer compartilhar cards e operações.

Sem essa variável, criação e operações locais usam SQLite e o endereçamento gera as posições localmente, mas o login seguro fica indisponível e os dados locais podem ser perdidos quando o container é recriado. Não deixamos uma senha administrativa fixa habilitada no serviço online.

Após salvar a variável, publique o commit mais recente em **Manual Deploy → Deploy latest commit** ou aguarde o deploy automático. A rota `/health` é o health check.

## Endereços
Zonas/casulos 01–20 e níveis A/B/C:
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
