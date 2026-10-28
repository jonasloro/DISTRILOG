# DISTRILOG · Stock 3D — primeira etapa integrada

Projeto de **visualização de estoque somente leitura** do DISTRILOG. O modelo
é carregado no navegador preferencialmente de um `.glb` pré-convertido.
Arquivos `.skb`/`.skp` pequenos também são aceitos. O arquivo original **não é enviado ao servidor**.

## Componentes

- `src/skp-worker.js`: importa SketchUp via `openskp` isolado em Web Worker;
  preserva as instâncias para diminuir geometria duplicada no GLB; geometria
  convertida no navegador.
- `src/main.js`: Three.js + OrbitControls; importação, exportação GLB,
  marcadores 3D, busca, detalhes e vínculo por clique.
- `src/core.js`: contratos WMS e validação de vínculos sem dados fictícios.
- `stock3d_module.py`: endpoint READ ONLY para buscar referência por endereço.
- `public/preview.svg`: ilustração genérica. A planta original não é publicada.

## Executar localmente

Requer Node.js 20.19+ ou 22.12+.

```sh
npm install
npm test
npm run dev
```

Para converter o backup de 80 MB em GLB de forma local (opção mais confiável para esse arquivo grande):

```sh
python -m pip install openskp==1.3.0 mapbox_earcut==1.0.3
python scripts/convert-skb.py "C:\\caminho\\1. COMPLETO.ATUAL(1).skb"
```

Depois importe o `.glb` na visualização. A conversão via navegador é limitada a arquivos SketchUp de até 24 MB. O arquivo original de 80 MB foi convertido com sucesso para um GLB de 28,7 MB; importe esse GLB.

Acesse a URL do terminal. A visualização funciona localmente, mas a **leitura
real do WMS exige servir a versão construída no mesmo domínio do DISTRILOG**,
pois a sessão usa cookie seguro/HTTP-only de mesma origem.

## Compilar para DISTRILOG

```sh
npm run build
```

O conteúdo de `dist/` deve ser copiado para `static/stock3d/` no
repositório DISTRILOG. O servidor já publica `/static` e o Stock 3D ficará
acessível em `/static/stock3d/index.html`. Instale o módulo de busca
`stock3d_module.py` e registre o roteador:

```python
from stock3d_module import register_stock3d_routes
# no bloco de outros register_*_routes(...):
register_stock3d_routes(app)
```

**Não adicione o arquivo `.skb` de 80 MB em um repositório público.** Cada
usuário pode converter localmente o `.skb` e salvar o `.glb` gerado para
posterior homologação. Para operação ampla, revise o tamanho do GLB, a
qualidade do mapeamento dos endereços, o controle de acesso e a performance.

## O que esta primeira versão entrega

1. Navegação 3D, zoom, vista superior e perspectiva.
2. Carregamento direto do GLB real do CD; conversão local de SketchUp pequeno
   com preservação de instâncias.
3. Listagem de todas as posições WMS por RM, QA, PR, ET e EC (mesmo domínio).
4. Consultas de conteúdo reais em `/api/positions/{address}/inventory`.
5. Pesquisa por referência através de API somente leitura.
6. Vinculação do endereço WMS a ponto físico, com marcadores sobre a malha.
7. Exportar/importar mapeamento JSON, **sem alterar o WMS**.

## Limitações de homologação

- O backup real de 80 MB foi convertido pelo OpenSKP Python. O GLB passou
  pela validação estrutural, mas precisa de homologação visual em navegador.
  A conversão de 80 MB via JavaScript esgotou memória e foi bloqueada.
- Ainda não existe mapeamento certo entre os objetos do SketchUp e os
  códigos reais de casulos. Este vínculo é manual e precisa ser conferido.
- O projeto não fornece roteamento de corredores, nem pré-calcula capacidade.
- Nunca grava saldos, transfere mercadorias ou movimenta cards.
- **ET/EC não têm andares** e seu saldo é mostrado em caixas pretas.
- A posição mostra lotes e referências somente conforme API do WMS.
