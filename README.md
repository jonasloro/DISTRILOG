# DISTRILOG — primeira etapa: criação de cards

Esta versão preserva a interface visual do projeto de referência `Distribox-` e mantém o cadastro manual de cards com **1 card por referência**.

## O que funciona nesta etapa

- Navegação e identidade visual base.
- Login demonstrativo (não valida credenciais).
- Cadastro manual de card com referência, fornecedor, NF opcional, lote opcional e grade de cores/tamanhos.
- Cálculo automático dos totais por cor, tamanho e grade.
- Visualização dos cards em Cadastros e Recebimento.
- Persistência em `localStorage`: os cards continuam no mesmo navegador após atualizar a página.

## O que ainda não está conectado

Não há API de negócio, banco de dados, sincronização entre usuários ou fluxo operacional real. Os demais módulos permanecem como interface visual para serem implementados por setor.

**Importante:** os cards ficam somente no armazenamento local do navegador. Limpar os dados do site ou usar outro navegador/dispositivo não levará os cards junto.

## Publicar no Render

O repositório inclui um `render.yaml` com os comandos de build e inicialização do serviço.

### Criar um serviço novo pelo Blueprint

1. No Render, escolha **New + → Blueprint**.
2. Selecione o repositório `jonasloro/DISTRILOG`.
3. O Render lerá o `render.yaml` e configurará o serviço.
4. Aguarde o deploy e abra a URL gerada pelo Render.

### Se o serviço Render já existe

No painel do serviço, em **Settings**, confira estes comandos:

- **Build Command:** `pip install -r requirements.txt`
- **Start Command:** `uvicorn app:app --host 0.0.0.0 --port $PORT`

A raiz do projeto deve ficar vazia (raiz do repositório). Salve as alterações e use **Manual Deploy → Deploy latest commit** caso o deploy não seja iniciado automaticamente após o commit.

A rota `/health` retorna o estado do serviço e está configurada como health check no Blueprint.

## Executar localmente

Requer Python 3.10 ou superior.

```bash
pip install -r requirements.txt
uvicorn app:app --reload
```

Abra http://127.0.0.1:8000.
