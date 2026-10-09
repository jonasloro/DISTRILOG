# DISTRILOG — primeira etapa: criação de cards

Esta versão preserva a interface visual do projeto de referência Distribox- e mantém o cadastro manual de cards com **1 card por referência**.

## O que funciona nesta etapa
- Navegação e identidade visual base.
- Login demonstrativo local (não valida credenciais).
- Cadastro manual de card com referência, fornecedor, NF opcional, lote opcional e grade de cores/tamanhos.
- Cálculo automático dos totais por cor, tamanho e grade.
- Visualização dos cards em Cadastros e Recebimento.
- Persistência no localStorage do navegador; os cards continuam lá ao atualizar a página no mesmo navegador.

## O que ainda não está conectado
Não há API de negócio, banco de dados, sincronização entre usuários ou fluxo operacional real. Os demais módulos permanecem como interface visual para serem implementados por setor.

## Executar localmente
Requer Python 3.10 ou superior.

~~~bash
pip install -r requirements.txt
uvicorn app:app --reload
~~~

Abra http://127.0.0.1:8000.

**Importante:** os cards desta etapa ficam somente no armazenamento local do navegador. Limpar os dados do site ou usar outro navegador/dispositivo não levará os cards junto.
