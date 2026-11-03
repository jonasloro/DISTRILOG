# DISTRILOG Mobile — protótipo de todos os setores conectado ao backend real

**Interface móvel própria**, baseada no arquivo HTML do protótipo de fluxos enviado
pelo operador. Mantém os mesmos padrões visuais: verde-limão, fundo escuro,
cards, indicadores e navegação inferior. Não carrega o DISTRILOG Web em WebView.
O WebView exibe **somente os recursos locais do APK**; uma ponte Android (OkHttp)
envia requisições HTTPS JSON à API real do Render.

## Instalação e conexão

Este APK de **homologação** usa assinatura debug. Instale em Android 7+.
Na primeira abertura, informe a URL HTTPS raiz do **seu serviço Render** e
entre com usuário e senha reais (mesma autenticação do app Web).
O identificador do app é
`com.distribox.distrilogmobile.prototype`, permitindo instalar em paralelo ao
APK anterior. Nunca incorpore tokens pessoais ou senhas no APK.

## O que foi conectado

- Login, sessão por cookie HttpOnly, alteração inicial de senha, idioma e saída;
- Filas de Recebimento, Qualidade, Processamento, Etiquetagem, Estocagem,
  Costura/despacho, Cadastro e Entrada;
- Consulta de cards reais, grade, status, histórico, endereços físicos,
  posições e conteúdo real dos endereços;
- Leitor QR e código de barras pela câmera: identificar Rack/ID e pesquisar;
- Recebimento: marcar chegada, salvar volumes, avarias, peças e 10%,
  controlar cronômetro, declarar volumes após tiragem e concluir
  com as validações do servidor;
- WMS: alocar em posições reais RM/QA/PR/ET/EC conforme regras originais
  (com contagem de caixas pretas em ET/EC);
- Qualidade: iniciar inspeção 1/2, parâmetros CD01/CD02, Costura,
  Desenvolvimento, atribuições, cronômetro, resultados e conclusão,
  além de transferência da segunda inspeção ao Processamento;
- Processamento: iniciar Triagem, contagem cega, pausa/retomada,
  conclusão e escolha de Etiquetagem/Estocagem; Entrada final;
- Etiquetagem/Estocagem: iniciar controles, assumir execução,
  apontar produção, pausa/retomada, conferências e conclusão.

**As permissões, saldos, mudanças de etapa e regras de WMS são aplicados
pelo backend.** O app não mantém um segundo banco, não simula cards,
não cria uma fila offline de operações e não salva dados sem confirmação.
Todos os passos definitivos solicitam confirmação.

## Limitações importantes para homologar

- **Não homologado em aparelho físico**: o APK só é publicado após compilar
  e conferir a assinatura no GitHub Actions. Testar cada fluxo com cards de
  homologação antes de usar em operação real.
- Não implementa criação de cards, transferência global entre endereços,
  upload de fotos ou chat no APK. Esses fluxos continuam no Web,
  até serem implementados com contratos próprios.
- Não garante paridade de todas as telas com o Web; opera o subconjunto
  de endpoints indicado acima. O protótipo antigo simulava passos que não
  tinham correspondente 1:1 no backend atual.
- A leitura de um Rack não pressupõe etiqueta padronizada: IDs
  numéricos e RACK-1234 resolvem por card; outros códigos servem
  apenas como pesquisa. Nenhuma leitura envia uma operação.
- As contagens cegas não exibem quantidades previstas para o operador.
- Exige internet e HTTPS. Um timeout pode ocorrer **depois** do servidor
  registrar uma ação: reabra o Card antes de tentar novamente.
- Os APKs debug são assinados com certificado de teste do runner: uma
  reinstalação por novo runner pode exigir desinstalar a versão anterior,
  perdendo apenas as preferências locais do APK (não os dados do WMS).
- O app armazena apenas o endereço HTTPS e metadados não secretos do
  usuário. A sessão é gerenciada pelo CookieManager privado do Android.
- O servidor determina as permissões: administradores podem visualizar
  filas diversas, mas as ações operacionais podem estar disponíveis
  apenas ao perfil responsável pelo setor.
- Não faz atualização automática do próprio APK.

## Build reproduzível

No GitHub, executar `Stock 3D...` **não** compila este APK. O workflow
exato é **DISTRILOG Mobile - Prototipo Integrado (APK)**. O arquivo será
publicado nos artifacts da execução como
`DISTRILOG-Mobile-PROTOTIPO-INTEGRADO.apk`.

O código Android fica isolado em `mobile-prototype/` e não altera o
backend, a branch principal nem o Render de produção.

## Versão piloto 1.1.0 — organização de espaço

No Android, a aba **Atividades** permite Abertura de espaço e Devolução ao porta-paletes, com fluxo guiado em 4 etapas: atividade → rua/marca → cronômetro persistente → quantidade e unidade obrigatórias. O registro é compartilhado com o DISTRILOG Web via `/api/space-activities` e armazenado no Supabase; não altera o saldo nem transfere fisicamente posições no WMS. O Card passa a separar Operar/Endereços/Grade/Histórico e as operações de Recebimento, Qualidade, Triagem e ET/EC exibem etapas em sequência, com navegação fixa na parte inferior. Os fluxos completos exigem homologação física. Não foram incluídos novos processos de Separação ou Expedição antes da definição das regras operacionais.

O pipeline desta versão gera um APK de homologação e publica uma **GitHub Release prerelease** com link direto de instalação (sem precisar baixar o ZIP de Artifacts). A assinatura debug do runner pode mudar entre builds: se o Android disser "app não instalado", desinstale apenas a versão anterior do APK protótipo e instale novamente (dados WMS permanecem no servidor).


## Atualizador de APK integrado (piloto 1.2.0)

Em Ajustes > Atualizações do aplicativo, o operador pode verificar, baixar
e instalar futuras versões diretamente no DISTRILOG Mobile. A verificação
também ocorre ao abrir o aplicativo. Nenhuma instalação é silenciosa: o
instalador do Android exige confirmação do usuário.

O aplicativo baixa exclusivamente do repositório público oficial
jonasloro/DISTRILOG, de releases com prefixo mobile-prototipo-X.Y.Z.
Exige o APK e checksum SHA-256 publicados na mesma release. Guarda o arquivo
temporariamente no cache privado e verifica SHA-256, identidade do pacote,
versionCode maior e assinatura digital igual à versão instalada.
A permissão para instalar fontes desconhecidas deve ser concedida no Android
8 ou superior, quando solicitada.

### Assinatura permanente: configuração única obrigatória

As versões piloto antigas usavam certificados DEBUG gerados por cada runner
do GitHub Actions. Por isso, versões debug distintas não necessariamente
atualizam uma à outra. O workflow agora prevê uma assinatura permanente para
a qual são necessários quatro GitHub Actions Secrets:

- MOBILE_SIGNING_KEYSTORE_B64 = Base64 dos bytes de sua keystore .jks
- MOBILE_SIGNING_STORE_PASSWORD = senha da keystore
- MOBILE_SIGNING_KEY_ALIAS = alias da chave
- MOBILE_SIGNING_KEY_PASSWORD = senha da chave

A keystore deve ser gerada por responsável técnico e guardada fora do
GitHub, do chat e do APK, com backup protegido. Nunca comite a chave privada.
Exemplo no Windows (JDK 17+):

    keytool -genkeypair -keystore distrilog-release.jks -alias distrilog-mobile -keyalg RSA -keysize 3072 -validity 11000

Exemplo PowerShell para gerar Base64 localmente:

    [Convert]::ToBase64String([IO.File]::ReadAllBytes("distrilog-release.jks"))

Configure os quatro secrets em GitHub > Settings > Secrets and variables >
Actions. O workflow gera então um APK RELEASE assinado com a mesma keystore e
o publica sob a tag mobile-prototipo-1.3.0 com APK e checksum. Depois, basta
aumentar versionCode, versionName e a tag do workflow em cada versão,
preservando os mesmos secrets.

Se faltar algum secret, o workflow compila um APK DEBUG assinado apenas
para homologação e publica na release mobile-piloto-1.3.0. Ela NAO entra
no canal de atualizações verificadas, justamente para evitar uma falsa
promessa de atualização. Uma única desinstalação do antigo APK debug
será necessária ao migrar para o APK com assinatura permanente.
A desinstalação não remove dados gravados no Supabase.

O atualizador não altera operações WMS, o backend Render, nem o banco.

## Versão 1.3.0 — Atividades dentro da Estocagem

As atividades **Abertura de espaço** e **Devolução ao porta-paletes** passam a ser acessadas **exclusivamente pela fila do setor Estocagem**, por dois botões distintos. A antiga aba global Atividades foi removida da barra inferior. Dentro do setor Estocagem, o operador toca na atividade desejada e vai diretamente à etapa Rua/Marca; depois, cronômetro e quantidade obrigatória. A atividade já iniciada permanece visível ao reabrir, com dados persistidos no servidor.

As cores **verde-lima e grafite do APK** permanecem inalteradas. Somente a navegação e os cartões locais de acesso às atividades foram ajustados. No Web, as atividades são subabas internas de Estocagem e usam a paleta dark azul/laranja original (alteração separada em main).

O aplicativo continua em homologação. Na falta de assinatura permanente configurada, o APK 1.3.0 é publicado como piloto e **não pode ser anunciado como uma atualização in-place** da versão 1.2.0; a atualização interna exige assinatura consistente, preservada entre versões. Os dados operacionais continuam no Supabase.


## Versão 1.4.0 — Separação e Expedição no APK

O menu de **Fila operacional** agora permite selecionar também:
- **Separação** — consome `GET /api/separation/orders`; mostra pedidos
  importados e suas quantidades elegíveis, timer líquido persistido no
  servidor, início, pausa com motivo, retomada e conclusão.
  No fechamento, exige **bags, caixas, peças, peso em kg, 0 à esquerda
  Sim/Não e pausa Sim/Não**; se houve pausa, motivo e tempo `hh:mm:ss`.
  A conclusão confirma o repasse à Expedição pelo backend; não inventa
  baixa de estoque, nem itens conferidos.
- **Expedição** — consome a fila `/api/unified/shipments` (mesma do Web),
  abre romaneio, permite conferir a quantidade declarada, preencher
  dados de transporte, salvar e confirmar a saída quando `PRONTO`.
  O backend permanece responsável pelas autorizações e validações.
- **Avisos de entradas** — referências com recebimento físico concluído
  ainda não encontradas em relatórios de pedidos importados, incluindo
  contagem de dias desde a entrada.

Os colaboradores do setor `separacao` veem a fila própria após login;
administradores e supervisores podem operá-la. A Expedição mantém os
papéis `expedicao`/`estocagem` e gestão. A consulta sem operação não
confere permissões adicionais.

**Atualização do APK:** o Android mostra um aviso visível no topo quando
existe release oficial assinada com versionCode superior. Em Ajustes →
Atualizações, o operador pode baixar o APK no cache privado e abrir o
instalador Android. Hash SHA-256, nome do pacote, versionCode e assinatura
digital são verificados antes da instalação. O Android exige consentimento
do operador e, a partir do Android 8, pode exigir a permissão de instalação
de fontes desconhecidas.

**Atenção ao piloto 1.4.0:** na ausência dos quatro Secrets
`MOBILE_SIGNING_*`, o workflow gera o arquivo
`mobile-piloto-1.4.0` com assinatura DEBUG TEMPORÁRIA. Este arquivo pode
ser testado em uma instalação nova, mas **não consegue garantir atualização
por cima do 1.3.0**. A partir da configuração da chave de assinatura
permanente, a release oficial será `mobile-prototipo-1.4.0` (mesmo pacote);
instale essa versão de transição e preserve a mesma chave nas futuras
releases. O app avisa sobre pilotos, mas não simula uma atualização
in-place impossível.

O sistema Android não lê a caixa de e-mail: o **CSV** chega ao backend pelo
importador do DISTRILOG Web. A ingestão automática de e-mail é uma etapa
independente que depende de configuração da conta de serviço e dos anexos.
Se o repositório passar a **privado**, o canal de updates por GitHub Releases
também deverá ser migrado para armazenamento HTTPS acessível a todos os
aparelhos, sem embutir token privado no APK.

