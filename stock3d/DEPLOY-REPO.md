# Implantação segura no DISTRILOG

Este pacote traz o frontend Stock 3D e o backend de pesquisa somente leitura.

- **Não** envie SKB/SKP, GLB, miniaturas reais nem o relatório de modelo a repositório público.
- Mantenha alterações em branch separada até validação com o Render.
- Adicione o módulo `stock3d_module.py` à raiz e registre seu roteador no bloco dos demais módulos em `app.py`.
- Rode `npm ci` (com lock gerado em ambiente confiável), `npm test`, `npm run build` na pasta stock3d.
- Publique os arquivos de `dist/` em `static/stock3d/` no mesmo serviço do Render.
- Acesse `/static/stock3d/index.html` enquanto autenticado no DISTRILOG.
- Mantenha homologação com dados de teste: o mapa tem acesso aos dados WMS reais e nunca deve fazer operações de escrita.

A integração completa depende de gerar/testar o bundle e calibrar os vínculos do modelo real com os endereços cadastrados. O SKB não foi convertido nesta entrega.
